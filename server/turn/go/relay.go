package main

import (
	"net"
	"sync"
	"time"

	"github.com/pion/turn/v4"
)

// tokenBucket caps one allocation's relayed bitrate; over the cap packets
// are dropped, as a congested link would.
type tokenBucket struct {
	mu     sync.Mutex
	rate   float64 // bytes per second
	burst  float64
	tokens float64
	last   time.Time
}

func newTokenBucket(bitsPerSecond int64) *tokenBucket {
	rate := float64(bitsPerSecond) / 8
	return &tokenBucket{rate: rate, burst: rate / 2, tokens: rate / 2, last: time.Now()}
}

func (b *tokenBucket) allow(n int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	b.tokens += now.Sub(b.last).Seconds() * b.rate
	if b.tokens > b.burst {
		b.tokens = b.burst
	}
	b.last = now
	if b.tokens < float64(n) {
		return false
	}
	b.tokens -= float64(n)
	return true
}

// meteredRelay wraps pion's port-range generator so every relay socket is
// rate-limited and counted.
type meteredRelay struct {
	*turn.RelayAddressGeneratorPortRange
	bitsPerSecond int64
	metrics       *metrics
}

func (g *meteredRelay) AllocatePacketConn(network string, port int) (net.PacketConn, net.Addr, error) {
	conn, addr, err := g.RelayAddressGeneratorPortRange.AllocatePacketConn(network, port)
	if err != nil {
		return nil, nil, err
	}
	m := &meteredConn{PacketConn: conn, metrics: g.metrics}
	if g.bitsPerSecond > 0 {
		m.toPeer, m.toClient = newTokenBucket(g.bitsPerSecond), newTokenBucket(g.bitsPerSecond)
	}
	return m, addr, nil
}

type meteredConn struct {
	net.PacketConn
	toPeer, toClient *tokenBucket
	metrics          *metrics
}

// WriteTo carries client -> peer.
func (c *meteredConn) WriteTo(b []byte, addr net.Addr) (int, error) {
	if c.toPeer != nil && !c.toPeer.allow(len(b)) {
		c.metrics.droppedPackets.Add(1)
		return len(b), nil
	}
	n, err := c.PacketConn.WriteTo(b, addr)
	c.metrics.bytesToPeer.Add(int64(n))
	return n, err
}

// ReadFrom carries peer -> client.
func (c *meteredConn) ReadFrom(b []byte) (int, net.Addr, error) {
	for {
		n, addr, err := c.PacketConn.ReadFrom(b)
		if err != nil {
			return n, addr, err
		}
		if c.toClient != nil && !c.toClient.allow(n) {
			c.metrics.droppedPackets.Add(1)
			continue
		}
		c.metrics.bytesToClient.Add(int64(n))
		return n, addr, nil
	}
}
