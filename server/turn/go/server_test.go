package main

import (
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec
	"encoding/base64"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/pion/turn/v4"
)

func TestPasswordMatchesEdgeFunction(t *testing.T) {
	a := newRESTAuth("secret", 5, time.Hour, &metrics{})
	// turn-credentials: btoa(HMAC-SHA1(COTURN_SECRET, username))
	if got := a.password("1700000000:user"); got != "I/MZeIG6MwzOV8Uubr9liB2556o=" {
		t.Fatalf("password %q", got)
	}
}

func TestAuthWindow(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	a := newRESTAuth("s", 5, time.Hour, &metrics{})
	a.now = func() time.Time { return now }
	user := func(expiry time.Time) string { return fmt.Sprintf("%d:u1", expiry.Unix()) }

	valid := user(now.Add(time.Minute))
	key, ok := a.authHandler(valid, "televo", nil)
	mac := hmac.New(sha1.New, []byte("s"))
	mac.Write([]byte(valid))
	want := turn.GenerateAuthKey(valid, "televo", base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	if !ok || string(key) != string(want) {
		t.Fatal("valid credential refused or wrong key")
	}
	if !a.quotaHandler(valid, "televo", nil) {
		t.Fatal("new allocation with a valid credential refused")
	}

	expired := user(now.Add(-time.Minute))
	if _, ok := a.authHandler(expired, "televo", nil); !ok {
		t.Fatal("refresh within the grace period refused")
	}
	if a.quotaHandler(expired, "televo", nil) {
		t.Fatal("new allocation with an expired credential accepted")
	}
	if _, ok := a.authHandler(user(now.Add(-2*time.Hour)), "televo", nil); ok {
		t.Fatal("credential past the grace period accepted")
	}
	for _, bad := range []string{"", "nouser", "abc:u1", "123:", "-5:u1"} {
		if _, ok := a.authHandler(bad, "televo", nil); ok {
			t.Fatalf("malformed username %q accepted", bad)
		}
	}
}

func TestUserQuotaFollowsAllocationEvents(t *testing.T) {
	a := newRESTAuth("s", 2, time.Hour, &metrics{})
	name := fmt.Sprintf("%d:u1", time.Now().Add(time.Hour).Unix())
	events := a.eventHandler()
	for i := 0; i < 2; i++ {
		if !a.quotaHandler(name, "", nil) {
			t.Fatalf("allocation %d refused", i)
		}
		events.OnAllocationCreated(nil, nil, "", name, "", nil, 0)
	}
	if a.quotaHandler(name, "", nil) {
		t.Fatal("third allocation accepted over a quota of 2")
	}
	events.OnAllocationDeleted(nil, nil, "", name, "")
	if !a.quotaHandler(name, "", nil) {
		t.Fatal("slot not freed after deletion")
	}
}

func TestPeerPolicy(t *testing.T) {
	p, err := newPeerPolicy(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, ip := range []string{"10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "::1", "fe80::1", "::ffff:10.0.0.1"} {
		if p.allows(net.ParseIP(ip)) {
			t.Errorf("%s allowed", ip)
		}
	}
	for _, ip := range []string{"8.8.8.8", "51.158.147.206", "2a00:1450::1"} {
		if !p.allows(net.ParseIP(ip)) {
			t.Errorf("%s denied", ip)
		}
	}
}

func TestTokenBucket(t *testing.T) {
	b := newTokenBucket(8_000) // 1000 bytes/s, burst 500
	if !b.allow(400) || b.allow(400) {
		t.Fatal("burst not enforced")
	}
	time.Sleep(450 * time.Millisecond)
	if !b.allow(400) {
		t.Fatal("tokens not refilled")
	}
}
