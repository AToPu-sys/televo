package main

import (
	"crypto/rand"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/pion/stun/v3"
	"github.com/pion/turn/v4"
)

type metrics struct {
	allocationsCreated, allocationsDeleted atomic.Int64
	authFailures, quotaRejections          atomic.Int64
	deniedPeers                            atomic.Int64
}

// health sends a STUN Binding to our own UDP listener; the server counts as
// alive only while that round trip works, and only then pets systemd's watchdog.
type health struct {
	target string
	lastOK atomic.Int64
}

func selfCheckTarget(udp []string) string {
	if len(udp) == 0 {
		return ""
	}
	_, port, err := net.SplitHostPort(udp[0])
	if err != nil {
		return ""
	}
	return net.JoinHostPort("127.0.0.1", port)
}

func newHealth(target string) *health { return &health{target: target} }

func (h *health) probe() error {
	conn, err := net.Dial("udp4", h.target)
	if err != nil {
		return err
	}
	defer conn.Close()
	var tid [stun.TransactionIDSize]byte
	_, _ = rand.Read(tid[:])
	req := stun.MustBuild(stun.NewTransactionIDSetter(tid), stun.BindingRequest, stun.Fingerprint)
	if _, err := conn.Write(req.Raw); err != nil {
		return err
	}
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	buf := make([]byte, 1500)
	n, err := conn.Read(buf)
	if err != nil {
		return err
	}
	res := &stun.Message{Raw: buf[:n]}
	if err := res.Decode(); err != nil {
		return err
	}
	if res.TransactionID != tid || res.Type != stun.BindingSuccess {
		return fmt.Errorf("unexpected self-check reply %s", res.Type)
	}
	return nil
}

func (h *health) run(every time.Duration) {
	if h.target == "" {
		return
	}
	for {
		if err := h.probe(); err == nil {
			h.lastOK.Store(time.Now().Unix())
			sdNotify("WATCHDOG=1")
		} else {
			log.Printf("self-check failed: %v", err)
		}
		time.Sleep(every)
	}
}

func (h *health) healthy() bool { return time.Now().Unix()-h.lastOK.Load() <= 10 }

func serveMetrics(addr string, m *metrics, h *health, s *turn.Server, l *connLimiter) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		if !h.healthy() {
			http.Error(w, "unhealthy", http.StatusServiceUnavailable)
			return
		}
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		var b strings.Builder
		gauge := func(name string, v int64) { fmt.Fprintf(&b, "%s %d\n", name, v) }
		gauge("turn_allocations", int64(s.AllocationCount()))
		gauge("turn_allocations_created_total", m.allocationsCreated.Load())
		gauge("turn_allocations_deleted_total", m.allocationsDeleted.Load())
		gauge("turn_auth_failures_total", m.authFailures.Load())
		gauge("turn_quota_rejections_total", m.quotaRejections.Load())
		gauge("turn_denied_peers_total", m.deniedPeers.Load())
		gauge("turn_stream_connections", l.current.Load())
		healthy := int64(0)
		if h.healthy() {
			healthy = 1
		}
		gauge("turn_healthy", healthy)
		_, _ = w.Write([]byte(b.String()))
	})
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	if err := srv.ListenAndServe(); err != nil {
		log.Printf("metrics endpoint: %v", err)
	}
}

func sdNotify(state string) {
	socket := os.Getenv("NOTIFY_SOCKET")
	if socket == "" {
		return
	}
	conn, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: socket, Net: "unixgram"})
	if err != nil {
		return
	}
	defer conn.Close()
	_, _ = conn.Write([]byte(state))
}
