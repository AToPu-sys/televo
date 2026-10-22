# Televo TURN relays

Two independent TURN relays (RFC 5766) for Televo calls, deployed side by
side so a bug or crash in one never takes calls down:

| | Go (`go/`) | Rust (`rust/`) |
|---|---|---|
| Core | [pion/turn](https://github.com/pion/turn) | own STUN/TURN implementation on tokio |
| Ports | UDP+TCP 3478, TLS 443 | UDP+TCP 3479, TLS 5349 |
| Relay ports | 50000–65535 | 40000–49999 |
| Metrics | `127.0.0.1:9478` | `127.0.0.1:9479` |

Both accept the TURN REST credentials the `turn-credentials` Edge Function
already issues (username `<expiry>:<user id>`, password
`base64(HMAC-SHA1(COTURN_SECRET, username))`), so the app needs no change:
the function lists them in `relays`, the app probes every relay and gives a
call the fastest three, and switches mid-call when one turns bad.

Behaviour both share:

- New allocations need an unexpired credential; an existing allocation may
  keep refreshing for 24 h past expiry, so long calls aren't cut.
- No relaying to private, loopback, link-local (cloud metadata), CGNAT,
  multicast or reserved addresses.
- 100 simultaneous allocations per user.
- Certificates are reloaded from disk on renewal: no restart, no dropped calls.
- `/healthz` is backed by a STUN round trip to the server's own UDP port,
  and only that pets the systemd watchdog — a stuck relay is restarted.

## Test

```sh
cd e2e && go test ./...      # builds and starts both relays locally
cd rust && cargo test        # codec (incl. RFC 5769 vectors), auth, policy
```

The e2e suite drives both relays with pion's TURN client over UDP, TCP and
TLS (echo, relay-to-relay, bad and expired credentials, denied peers, quota)
and with two pion/webrtc peers restricted to relay candidates.

## Deploy

On a fresh Ubuntu VM with a public IP (Oracle Cloud Always Free works):

```sh
server/turn/deploy/deploy.sh <public-ip> [ssh-user] [ssh-key]
```

It uploads the sources, runs `deploy/setup.sh` (builds both relays, firewall,
kernel buffers, Let's Encrypt for `<ip>.sslip.io`, systemd units), runs the
e2e suite against the VM from the Mac, then deploys `turn-credentials` and
sets `COTURN_SECRET` and `COTURN_HOSTS`. Cloud firewall ingress to open:
UDP 3478-3479, TCP 80, 443, 3478-3479, 5349, UDP 40000-65535.
