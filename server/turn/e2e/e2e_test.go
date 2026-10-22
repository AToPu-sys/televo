// End-to-end tests for both Televo TURN servers with real clients: pion's
// TURN client over UDP, TCP and TLS, and pion/webrtc forced onto relays.
// Run: go test ./... (builds both servers first).
package e2e

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
	"github.com/pion/webrtc/v4"
)

var secret = "e2e-shared-secret"

type server struct {
	name          string
	udp, tcp, tls string
	metrics       string
	host          string // TLS server name; empty for the local self-signed servers
}

// remote is set when TURN_E2E_HOSTS points the suite at deployed relays
// ("host[:port:tlsPort],..." like COTURN_HOSTS, secret in TURN_E2E_SECRET_FILE).
var remote bool

func remoteServers() []server {
	var out []server
	for _, entry := range strings.Split(os.Getenv("TURN_E2E_HOSTS"), ",") {
		parts := strings.Split(strings.TrimSpace(entry), ":")
		port, tlsPort := "3478", "443"
		if len(parts) == 3 {
			port, tlsPort = parts[1], parts[2]
		}
		out = append(out, server{name: parts[0], host: parts[0],
			udp: parts[0] + ":" + port, tcp: parts[0] + ":" + port, tls: parts[0] + ":" + tlsPort})
	}
	return out
}

var servers []server

func TestMain(m *testing.M) {
	if os.Getenv("TURN_E2E_HOSTS") != "" {
		b, err := os.ReadFile(os.Getenv("TURN_E2E_SECRET_FILE"))
		if err != nil {
			panic(err)
		}
		secret, remote, servers = strings.TrimSpace(string(b)), true, remoteServers()
		os.Exit(m.Run())
	}
	dir, err := os.MkdirTemp("", "televo-turn-e2e")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(dir)
	cert, key := writeCert(dir)
	secretFile := filepath.Join(dir, "secret")
	_ = os.WriteFile(secretFile, []byte(secret+"\n"), 0o600)

	goBin := filepath.Join(dir, "televo-turn-go")
	mustRun(exec.Command("go", "build", "-o", goBin, "."), "../go")
	mustRun(exec.Command("cargo", "build", "--release"), "../rust")
	rsBin, _ := filepath.Abs("../rust/target/release/televo-turn-rs")

	defs := []struct {
		name, bin string
		base      int
	}{{"go", goBin, 13000}, {"rust", rsBin, 23000}}
	var procs []*exec.Cmd
	for _, d := range defs {
		s := server{
			name:    d.name,
			udp:     fmt.Sprintf("127.0.0.1:%d", d.base+478),
			tcp:     fmt.Sprintf("127.0.0.1:%d", d.base+478),
			tls:     fmt.Sprintf("127.0.0.1:%d", d.base+443),
			metrics: fmt.Sprintf("127.0.0.1:%d", d.base+900),
		}
		cmd := exec.Command(d.bin,
			"--realm", "televo", "--external-ip", "127.0.0.1", "--relay-bind-ip", "127.0.0.1",
			"--udp", s.udp, "--tcp", s.tcp, "--tls", s.tls, "--cert", cert, "--key", key,
			"--min-port", fmt.Sprint(d.base+30000), "--max-port", fmt.Sprint(d.base+30999),
			"--secret-file", secretFile, "--metrics", s.metrics, "--allow-peer", "127.0.0.0/8", "--user-quota", "5")
		if d.name == "go" {
			for i, a := range cmd.Args {
				if strings.HasPrefix(a, "--") {
					cmd.Args[i] = a[1:]
				}
			}
		}
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Start(); err != nil {
			panic(err)
		}
		procs = append(procs, cmd)
		servers = append(servers, s)
	}
	for _, s := range servers {
		waitHealthy(s)
	}
	code := m.Run()
	for _, p := range procs {
		_ = p.Process.Kill()
		_ = p.Wait()
	}
	os.Exit(code)
}

func mustRun(cmd *exec.Cmd, dir string) {
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		panic(fmt.Sprintf("%v: %s", err, out))
	}
}

func waitHealthy(s server) {
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if res, err := http.Get("http://" + s.metrics + "/healthz"); err == nil {
			res.Body.Close()
			if res.StatusCode == 200 {
				return
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	panic(s.name + " server never became healthy")
}

func writeCert(dir string) (string, string) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"},
		DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	keyDER, _ := x509.MarshalECPrivateKey(key)
	certPath, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	_ = os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	_ = os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600)
	return certPath, keyPath
}

// credentials exactly as the turn-credentials Edge Function mints them.
func credentials(user string, ttl time.Duration) (string, string) {
	username := fmt.Sprintf("%d:%s", time.Now().Add(ttl).Unix(), user)
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	return username, base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func dial(t *testing.T, s server, transport string) net.PacketConn {
	t.Helper()
	switch transport {
	case "udp":
		c, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		return c
	case "tcp":
		c, err := net.Dial("tcp", s.tcp)
		if err != nil {
			t.Fatal(err)
		}
		return turn.NewSTUNConn(c)
	default:
		cfg := &tls.Config{ServerName: s.host}
		if s.host == "" {
			cfg.InsecureSkipVerify = true //nolint:gosec // local self-signed test cert
		}
		c, err := tls.Dial("tcp", s.tls, cfg)
		if err != nil {
			t.Fatal(err)
		}
		return turn.NewSTUNConn(c)
	}
}

func client(t *testing.T, s server, transport, username, password string) (*turn.Client, error) {
	t.Helper()
	conn := dial(t, s, transport)
	addr := s.udp
	if transport != "udp" {
		addr = s.tcp
	}
	c, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: addr, TURNServerAddr: addr, Conn: conn,
		Username: username, Password: password, Realm: "televo",
		LoggerFactory: logging.NewDefaultLoggerFactory(),
	})
	if err != nil {
		return nil, err
	}
	if err := c.Listen(); err != nil {
		return nil, err
	}
	t.Cleanup(func() { c.Close(); conn.Close() })
	return c, nil
}

func echoPeer(t *testing.T) net.PacketConn {
	t.Helper()
	peer, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { peer.Close() })
	go func() {
		buf := make([]byte, 2048)
		for {
			n, from, err := peer.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = peer.WriteTo(buf[:n], from)
		}
	}()
	return peer
}

func forEach(t *testing.T, fn func(t *testing.T, s server, transport string)) {
	for _, s := range servers {
		for _, tr := range []string{"udp", "tcp", "tls"} {
			s, tr := s, tr
			t.Run(s.name+"/"+tr, func(t *testing.T) { fn(t, s, tr) })
		}
	}
}

func TestRelayEcho(t *testing.T) {
	if remote {
		t.Skip("needs a peer the relay can reach; local only")
	}
	forEach(t, func(t *testing.T, s server, transport string) {
		user, pass := credentials("user-echo-"+transport, time.Hour)
		c, err := client(t, s, transport, user, pass)
		if err != nil {
			t.Fatal(err)
		}
		relay, err := c.Allocate()
		if err != nil {
			t.Fatalf("allocate: %v", err)
		}
		defer relay.Close()
		if got := relay.LocalAddr().(*net.UDPAddr).IP.String(); got != "127.0.0.1" {
			t.Fatalf("relayed address %s, want the external IP", got)
		}
		peer := echoPeer(t)
		// Enough packets to cover the Send-indication path and, once pion's
		// channel binding lands, the ChannelData path.
		buf := make([]byte, 2048)
		for i := 0; i < 40; i++ {
			msg := []byte(fmt.Sprintf("packet %d %s", i, strings.Repeat("x", i*25)))
			if _, err := relay.WriteTo(msg, peer.LocalAddr()); err != nil {
				t.Fatalf("write %d: %v", i, err)
			}
			_ = relay.SetReadDeadline(time.Now().Add(3 * time.Second))
			n, from, err := relay.ReadFrom(buf)
			if err != nil {
				t.Fatalf("read %d: %v", i, err)
			}
			if !bytes.Equal(buf[:n], msg) || from.String() != peer.LocalAddr().String() {
				t.Fatalf("packet %d came back as %q from %s", i, buf[:n], from)
			}
			time.Sleep(25 * time.Millisecond)
		}
	})
}

func TestRelayToRelay(t *testing.T) {
	forEach(t, func(t *testing.T, s server, transport string) {
		ua, pa := credentials("user-a", time.Hour)
		ub, pb := credentials("user-b", time.Hour)
		ca, err := client(t, s, transport, ua, pa)
		if err != nil {
			t.Fatal(err)
		}
		cb, err := client(t, s, "udp", ub, pb)
		if err != nil {
			t.Fatal(err)
		}
		ra, err := ca.Allocate()
		if err != nil {
			t.Fatal(err)
		}
		defer ra.Close()
		rb, err := cb.Allocate()
		if err != nil {
			t.Fatal(err)
		}
		defer rb.Close()
		// Each side permits the other first, as ICE does.
		if _, err := rb.WriteTo([]byte("hello"), ra.LocalAddr()); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 1500)
		for i := 0; i < 10; i++ {
			if _, err := ra.WriteTo([]byte("ping"), rb.LocalAddr()); err != nil {
				t.Fatal(err)
			}
			_ = rb.SetReadDeadline(time.Now().Add(2 * time.Second))
			n, _, err := rb.ReadFrom(buf)
			if err == nil && string(buf[:n]) == "ping" {
				return
			}
		}
		t.Fatal("relay-to-relay packet never arrived")
	})
}

func TestRejectsBadCredentials(t *testing.T) {
	forEach(t, func(t *testing.T, s server, transport string) {
		user, _ := credentials("user-bad", time.Hour)
		if c, err := client(t, s, transport, user, "wrong"); err == nil {
			if _, err := c.Allocate(); err == nil {
				t.Fatal("allocated with a wrong password")
			}
		}
		expired, pass := credentials("user-expired", -time.Minute)
		if c, err := client(t, s, transport, expired, pass); err == nil {
			if _, err := c.Allocate(); err == nil {
				t.Fatal("allocated with an expired credential")
			}
		}
	})
}

func TestDeniesInternalPeers(t *testing.T) {
	forEach(t, func(t *testing.T, s server, transport string) {
		user, pass := credentials("user-deny", time.Hour)
		c, err := client(t, s, transport, user, pass)
		if err != nil {
			t.Fatal(err)
		}
		relay, err := c.Allocate()
		if err != nil {
			t.Fatal(err)
		}
		defer relay.Close()
		for _, target := range []string{"10.0.0.1:9", "169.254.169.254:80", "192.168.1.1:53"} {
			addr, _ := net.ResolveUDPAddr("udp4", target)
			if _, err := relay.WriteTo([]byte("x"), addr); err == nil {
				t.Fatalf("relayed to internal address %s", target)
			}
		}
	})
}

func TestUserQuota(t *testing.T) {
	if remote {
		t.Skip("needs a peer the relay can reach; local only")
	}
	for _, s := range servers {
		t.Run(s.name, func(t *testing.T) {
			var relays []net.PacketConn
			defer func() {
				for _, r := range relays {
					r.Close()
				}
			}()
			got := 0
			for i := 0; i < 7; i++ {
				user, pass := credentials("user-quota", time.Hour)
				c, err := client(t, s, "udp", user, pass)
				if err != nil {
					t.Fatal(err)
				}
				if r, err := c.Allocate(); err == nil {
					relays = append(relays, r)
					got++
				}
			}
			if got != 5 {
				t.Fatalf("got %d allocations for one user, want the quota of 5", got)
			}
		})
	}
}

// Two real WebRTC peers that may only use relay candidates from this server.
func TestWebRTCOverRelay(t *testing.T) {
	for _, s := range servers {
		for _, tr := range []string{"udp", "tcp"} {
			s, tr := s, tr
			t.Run(s.name+"/"+tr, func(t *testing.T) {
				url := "turn:" + s.udp + "?transport=" + tr
				newPeer := func(user string) *webrtc.PeerConnection {
					username, password := credentials(user, time.Hour)
					pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
						ICEServers:         []webrtc.ICEServer{{URLs: []string{url}, Username: username, Credential: password}},
						ICETransportPolicy: webrtc.ICETransportPolicyRelay,
					})
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() { pc.Close() })
					return pc
				}
				a, b := newPeer("caller"), newPeer("callee")
				for _, pair := range [][2]*webrtc.PeerConnection{{a, b}, {b, a}} {
					from, to := pair[0], pair[1]
					from.OnICECandidate(func(c *webrtc.ICECandidate) {
						if c != nil {
							_ = to.AddICECandidate(c.ToJSON())
						}
					})
				}
				got := make(chan string, 1)
				b.OnDataChannel(func(dc *webrtc.DataChannel) {
					dc.OnMessage(func(m webrtc.DataChannelMessage) { got <- string(m.Data) })
				})
				dc, err := a.CreateDataChannel("call", nil)
				if err != nil {
					t.Fatal(err)
				}
				dc.OnOpen(func() { _ = dc.SendText("hello over " + tr) })
				offer, _ := a.CreateOffer(nil)
				_ = a.SetLocalDescription(offer)
				_ = b.SetRemoteDescription(offer)
				answer, _ := b.CreateAnswer(nil)
				_ = b.SetLocalDescription(answer)
				_ = a.SetRemoteDescription(answer)
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				defer cancel()
				select {
				case msg := <-got:
					if msg != "hello over "+tr {
						t.Fatalf("got %q", msg)
					}
				case <-ctx.Done():
					t.Fatalf("no data channel message: ICE %s", a.ICEConnectionState())
				}
				pair, _ := a.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
				if pair == nil || pair.Local.Typ != webrtc.ICECandidateTypeRelay {
					t.Fatalf("selected pair is not relayed: %v", pair)
				}
			})
		}
	}
}
