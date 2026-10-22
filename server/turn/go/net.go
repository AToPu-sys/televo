package main

import (
	"context"
	"crypto/tls"
	"net"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

func listenUDP(addr string) (net.PacketConn, error) {
	lc := net.ListenConfig{Control: func(_, _ string, c syscall.RawConn) error {
		var sockErr error
		err := c.Control(func(fd uintptr) { sockErr = setSocketOptions(int(fd)) })
		if err != nil {
			return err
		}
		return sockErr
	}}
	return lc.ListenPacket(context.Background(), "udp4", addr)
}

// A TCP/TLS connection idle this long is closed: an allocation refreshes
// every few minutes, so only abandoned connections reach it.
const streamIdleTimeout = 15 * time.Minute

const tlsHandshakeTimeout = 10 * time.Second

type connLimiter struct {
	max     int64
	current atomic.Int64
}

func newConnLimiter(max int) *connLimiter { return &connLimiter{max: int64(max)} }

func (l *connLimiter) wrap(inner net.Listener, tlsConfig *tls.Config) net.Listener {
	return &limitedListener{Listener: inner, limiter: l, tls: tlsConfig}
}

type limitedListener struct {
	net.Listener
	limiter *connLimiter
	tls     *tls.Config
}

func (l *limitedListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if l.limiter.current.Add(1) > l.limiter.max {
			l.limiter.current.Add(-1)
			_ = conn.Close()
			continue
		}
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.SetNoDelay(true)
		}
		c := &streamConn{Conn: conn, limiter: l.limiter}
		if l.tls != nil {
			c.tls = tls.Server(conn, l.tls)
		}
		return c, nil
	}
}

// streamConn bounds the TLS handshake, closes idle connections and gives the
// slot back to the limiter exactly once.
type streamConn struct {
	net.Conn
	tls       *tls.Conn
	limiter   *connLimiter
	handshake sync.Once
	hsErr     error
	closed    sync.Once
}

func (c *streamConn) inner() net.Conn {
	if c.tls != nil {
		return c.tls
	}
	return c.Conn
}

func (c *streamConn) Read(b []byte) (int, error) {
	if c.tls != nil {
		c.handshake.Do(func() {
			_ = c.Conn.SetDeadline(time.Now().Add(tlsHandshakeTimeout))
			c.hsErr = c.tls.Handshake()
			_ = c.Conn.SetDeadline(time.Time{})
		})
		if c.hsErr != nil {
			return 0, c.hsErr
		}
	}
	_ = c.Conn.SetReadDeadline(time.Now().Add(streamIdleTimeout))
	return c.inner().Read(b)
}

func (c *streamConn) Write(b []byte) (int, error) { return c.inner().Write(b) }

func (c *streamConn) Close() error {
	err := c.inner().Close()
	c.closed.Do(func() { c.limiter.current.Add(-1) })
	return err
}
