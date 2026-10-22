package main

import (
	"crypto/tls"
	"log"
	"os"
	"sync"
	"time"
)

// certReloader serves the certificate from disk and picks up a renewed one
// without a restart, so certbot renewals never drop calls.
type certReloader struct {
	certPath, keyPath string
	mu                sync.RWMutex
	cert              *tls.Certificate
	stamp             time.Time
}

func newCertReloader(certPath, keyPath string) (*certReloader, error) {
	r := &certReloader{certPath: certPath, keyPath: keyPath}
	return r, r.load()
}

func (r *certReloader) modTime() time.Time {
	var latest time.Time
	for _, p := range []string{r.certPath, r.keyPath} {
		if st, err := os.Stat(p); err == nil && st.ModTime().After(latest) {
			latest = st.ModTime()
		}
	}
	return latest
}

func (r *certReloader) load() error {
	stamp := r.modTime()
	cert, err := tls.LoadX509KeyPair(r.certPath, r.keyPath)
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.cert, r.stamp = &cert, stamp
	r.mu.Unlock()
	return nil
}

func (r *certReloader) get(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.cert, nil
}

func (r *certReloader) watch(every time.Duration) {
	for range time.Tick(every) {
		r.mu.RLock()
		stamp := r.stamp
		r.mu.RUnlock()
		if r.modTime().Equal(stamp) {
			continue
		}
		if err := r.load(); err != nil {
			log.Printf("certificate reload failed, keeping the old one: %v", err)
		} else {
			log.Printf("certificate reloaded")
		}
	}
}
