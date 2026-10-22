package e2e

import (
	"net"
	"testing"
	"time"
)

// relayPair allocates on one server for two clients and opens permissions
// both ways, like two phones that picked the same relay.
func relayPair(b *testing.B, s server) (net.PacketConn, net.PacketConn) {
	t := &testing.T{}
	ua, pa := credentials("bench-a", time.Hour)
	ub, pb := credentials("bench-b", time.Hour)
	ca, err := client(t, s, "udp", ua, pa)
	if err != nil {
		b.Fatal(err)
	}
	cb, err := client(t, s, "udp", ub, pb)
	if err != nil {
		b.Fatal(err)
	}
	ra, err := ca.Allocate()
	if err != nil {
		b.Fatal(err)
	}
	rb, err := cb.Allocate()
	if err != nil {
		b.Fatal(err)
	}
	_, _ = ra.WriteTo([]byte("open"), rb.LocalAddr())
	_, _ = rb.WriteTo([]byte("open"), ra.LocalAddr())
	time.Sleep(300 * time.Millisecond) // let channel bindings land
	b.Cleanup(func() { ra.Close(); rb.Close() })
	return ra, rb
}

// BenchmarkRelayRoundTrip: a 1200-byte packet (a video RTP packet) from A to
// B and back, both through the relay. go test -bench . -run ^$
func BenchmarkRelayRoundTrip(b *testing.B) {
	for _, s := range servers {
		b.Run(s.name, func(b *testing.B) {
			ra, rb := relayPair(b, s)
			go func() {
				buf := make([]byte, 1500)
				for {
					n, from, err := rb.ReadFrom(buf)
					if err != nil {
						return
					}
					_, _ = rb.WriteTo(buf[:n], from)
				}
			}()
			payload := make([]byte, 1200)
			buf := make([]byte, 1500)
			lost := 0
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := ra.WriteTo(payload, rb.LocalAddr()); err != nil {
					b.Fatal(err)
				}
				_ = ra.SetReadDeadline(time.Now().Add(time.Second))
				if _, _, err := ra.ReadFrom(buf); err != nil {
					lost++
				}
			}
			b.ReportMetric(float64(lost), "lost")
		})
	}
}
