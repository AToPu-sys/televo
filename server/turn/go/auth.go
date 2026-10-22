package main

import (
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // TURN REST credentials are defined over HMAC-SHA1.
	"encoding/base64"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/turn/v4"
)

// restAuth checks TURN REST credentials: username "<unix expiry>:<user id>",
// password base64(HMAC-SHA1(secret, username)).
type restAuth struct {
	secret  []byte
	quota   int
	grace   time.Duration
	metrics *metrics
	now     func() time.Time

	mu      sync.Mutex
	perUser map[string]int
}

func newRESTAuth(secret string, quota int, grace time.Duration, m *metrics) *restAuth {
	return &restAuth{secret: []byte(secret), quota: quota, grace: grace, metrics: m, now: time.Now, perUser: map[string]int{}}
}

// parseUsername splits "<expiry>:<user id>".
func parseUsername(username string) (expiry time.Time, user string, ok bool) {
	ts, user, found := strings.Cut(username, ":")
	if !found || user == "" {
		return time.Time{}, "", false
	}
	secs, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || secs <= 0 {
		return time.Time{}, "", false
	}
	return time.Unix(secs, 0), user, true
}

func (a *restAuth) password(username string) string {
	mac := hmac.New(sha1.New, a.secret)
	mac.Write([]byte(username))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// authHandler accepts a credential until refresh-grace past its expiry, so a
// call outliving its credential keeps refreshing; new allocations need an
// unexpired one (quotaHandler).
func (a *restAuth) authHandler(username, realm string, _ net.Addr) ([]byte, bool) {
	expiry, _, ok := parseUsername(username)
	if !ok || a.now().After(expiry.Add(a.grace)) {
		a.metrics.authFailures.Add(1)
		return nil, false
	}
	return turn.GenerateAuthKey(username, realm, a.password(username)), true
}

func (a *restAuth) quotaHandler(username, _ string, _ net.Addr) bool {
	expiry, user, ok := parseUsername(username)
	if !ok || a.now().After(expiry) {
		a.metrics.authFailures.Add(1)
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.perUser[user] >= a.quota {
		a.metrics.quotaRejections.Add(1)
		return false
	}
	return true
}

func (a *restAuth) eventHandler() turn.EventHandler {
	return turn.EventHandler{
		OnAuth: func(_, _ net.Addr, _, _, _, _ string, verdict bool) {
			if !verdict {
				a.metrics.authFailures.Add(1)
			}
		},
		OnAllocationCreated: func(_, _ net.Addr, _, username, _ string, _ net.Addr, _ int) {
			a.metrics.allocationsCreated.Add(1)
			if _, user, ok := parseUsername(username); ok {
				a.mu.Lock()
				a.perUser[user]++
				a.mu.Unlock()
			}
		},
		OnAllocationDeleted: func(_, _ net.Addr, _, username, _ string) {
			a.metrics.allocationsDeleted.Add(1)
			if _, user, ok := parseUsername(username); ok {
				a.mu.Lock()
				if a.perUser[user]--; a.perUser[user] <= 0 {
					delete(a.perUser, user)
				}
				a.mu.Unlock()
			}
		},
	}
}
