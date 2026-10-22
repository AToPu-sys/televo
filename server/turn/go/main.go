// Command televo-turn-go is Televo's TURN relay built on pion/turn: UDP and
// TCP on 3478, TLS on 443, credentials in the TURN REST format that the
// turn-credentials Edge Function signs with the shared secret.
package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
)

type config struct {
	realm        string
	externalIP   string
	relayBind    string
	udp          string
	tcp          string
	tls          string
	cert, key    string
	minPort      uint
	maxPort      uint
	secretFile   string
	userQuota    int
	refreshGrace time.Duration
	metrics      string
	allowPeers   string
	maxConns     int
	maxBitrate   int64
}

func env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func parseConfig() config {
	var c config
	flag.StringVar(&c.realm, "realm", env("TURN_REALM", "televo"), "realm sent to clients")
	flag.StringVar(&c.externalIP, "external-ip", env("TURN_EXTERNAL_IP", ""), "public IPv4 advertised as the relayed address")
	flag.StringVar(&c.relayBind, "relay-bind-ip", env("TURN_RELAY_BIND_IP", "0.0.0.0"), "local address relay sockets bind to")
	flag.StringVar(&c.udp, "udp", env("TURN_UDP", "0.0.0.0:3478"), "comma-separated UDP listen addresses")
	flag.StringVar(&c.tcp, "tcp", env("TURN_TCP", "0.0.0.0:3478"), "comma-separated TCP listen addresses")
	flag.StringVar(&c.tls, "tls", env("TURN_TLS", ""), "comma-separated TLS listen addresses")
	flag.StringVar(&c.cert, "cert", env("TURN_TLS_CERT", ""), "TLS certificate chain (PEM), reloaded when it changes")
	flag.StringVar(&c.key, "key", env("TURN_TLS_KEY", ""), "TLS private key (PEM)")
	flag.UintVar(&c.minPort, "min-port", 49152, "lowest relay port")
	flag.UintVar(&c.maxPort, "max-port", 65535, "highest relay port")
	flag.StringVar(&c.secretFile, "secret-file", env("TURN_SECRET_FILE", ""), "file with the shared secret (default: $CREDENTIALS_DIRECTORY/secret, then $TURN_SECRET)")
	flag.IntVar(&c.userQuota, "user-quota", 100, "simultaneous allocations per user")
	flag.DurationVar(&c.refreshGrace, "refresh-grace", 24*time.Hour, "how long an expired credential may keep refreshing an allocation it already holds")
	flag.StringVar(&c.metrics, "metrics", env("TURN_METRICS", "127.0.0.1:9478"), "address for /metrics and /healthz")
	flag.StringVar(&c.allowPeers, "allow-peer", env("TURN_ALLOW_PEERS", ""), "comma-separated peer CIDRs allowed despite the deny list (tests only)")
	flag.IntVar(&c.maxConns, "max-tcp-connections", 20000, "simultaneous TCP/TLS connections")
	flag.Int64Var(&c.maxBitrate, "max-bitrate", 20_000_000, "bits per second one allocation may relay each way (0 = unlimited)")
	flag.Parse()
	return c
}

func loadSecret(path string) (string, error) {
	if path == "" {
		if dir := os.Getenv("CREDENTIALS_DIRECTORY"); dir != "" {
			path = dir + "/secret"
		}
	}
	if path == "" {
		if s := os.Getenv("TURN_SECRET"); s != "" {
			return s, nil
		}
		return "", fmt.Errorf("no secret: set -secret-file, systemd LoadCredential=secret or TURN_SECRET")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return "", fmt.Errorf("secret file %s is empty", path)
	}
	return s, nil
}

func splitList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

func main() {
	cfg := parseConfig()
	secret, err := loadSecret(cfg.secretFile)
	if err != nil {
		log.Fatal(err)
	}
	publicIP := net.ParseIP(cfg.externalIP)
	if publicIP == nil || publicIP.To4() == nil {
		log.Fatal("-external-ip must be the server's public IPv4 address")
	}
	policy, err := newPeerPolicy(splitList(cfg.allowPeers))
	if err != nil {
		log.Fatal(err)
	}
	metrics := &metrics{}
	auth := newRESTAuth(secret, cfg.userQuota, cfg.refreshGrace, metrics)

	relayGen := func() turn.RelayAddressGenerator {
		return &meteredRelay{
			RelayAddressGeneratorPortRange: &turn.RelayAddressGeneratorPortRange{
				RelayAddress: publicIP,
				Address:      cfg.relayBind,
				MinPort:      uint16(cfg.minPort),
				MaxPort:      uint16(cfg.maxPort),
				MaxRetries:   64,
			},
			bitsPerSecond: cfg.maxBitrate,
			metrics:       metrics,
		}
	}
	permit := func(client net.Addr, peer net.IP) bool {
		if policy.allows(peer) {
			return true
		}
		metrics.deniedPeers.Add(1)
		return false
	}

	var packetConns []turn.PacketConnConfig
	for _, addr := range splitList(cfg.udp) {
		// One socket per core with SO_REUSEPORT: the kernel keeps each client
		// on one socket, so packets of one flow are never reordered.
		for i := 0; i < reusePortCount(); i++ {
			pc, err := listenUDP(addr)
			if err != nil {
				log.Fatalf("udp %s: %v", addr, err)
			}
			packetConns = append(packetConns, turn.PacketConnConfig{PacketConn: pc, RelayAddressGenerator: relayGen(), PermissionHandler: permit})
		}
	}

	limiter := newConnLimiter(cfg.maxConns)
	var listeners []turn.ListenerConfig
	for _, addr := range splitList(cfg.tcp) {
		l, err := net.Listen("tcp4", addr)
		if err != nil {
			log.Fatalf("tcp %s: %v", addr, err)
		}
		listeners = append(listeners, turn.ListenerConfig{Listener: limiter.wrap(l, nil), RelayAddressGenerator: relayGen(), PermissionHandler: permit})
	}
	var certs *certReloader
	if tlsAddrs := splitList(cfg.tls); len(tlsAddrs) > 0 {
		certs, err = newCertReloader(cfg.cert, cfg.key)
		if err != nil {
			log.Fatalf("tls: %v", err)
		}
		tlsConfig := &tls.Config{GetCertificate: certs.get, MinVersion: tls.VersionTLS12}
		for _, addr := range tlsAddrs {
			l, err := net.Listen("tcp4", addr)
			if err != nil {
				log.Fatalf("tls %s: %v", addr, err)
			}
			listeners = append(listeners, turn.ListenerConfig{Listener: limiter.wrap(l, tlsConfig), RelayAddressGenerator: relayGen(), PermissionHandler: permit})
		}
		go certs.watch(time.Minute)
	}

	loggers := logging.NewDefaultLoggerFactory()
	loggers.DefaultLogLevel = logging.LogLevelWarn
	server, err := turn.NewServer(turn.ServerConfig{
		Realm:             cfg.realm,
		AuthHandler:       auth.authHandler,
		QuotaHandler:      auth.quotaHandler,
		EventHandler:      auth.eventHandler(),
		PacketConnConfigs: packetConns,
		ListenerConfigs:   listeners,
		LoggerFactory:     loggers,
		InboundMTU:        65536,
	})
	if err != nil {
		log.Fatal(err)
	}

	selfCheck := selfCheckTarget(splitList(cfg.udp))
	health := newHealth(selfCheck)
	go health.run(2 * time.Second)
	go serveMetrics(cfg.metrics, metrics, health, server, limiter)

	log.Printf("televo-turn-go %s up: realm=%s external=%s udp=%s tcp=%s tls=%s relay=%d-%d cores=%d",
		version, cfg.realm, publicIP, cfg.udp, cfg.tcp, cfg.tls, cfg.minPort, cfg.maxPort, runtime.NumCPU())
	sdNotify("READY=1")

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	sdNotify("STOPPING=1")
	_ = server.Close()
}

const version = "1.0.0"
