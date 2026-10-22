#!/usr/bin/env bash
# Installs both Televo TURN relays on a fresh Ubuntu 22.04/24.04 VM (Oracle
# Cloud Always Free or any other), run as root from the uploaded server/turn
# directory:
#
#   TURN_SECRET=<COTURN_SECRET of turn-credentials> bash deploy/setup.sh
#
#   Go relay:   UDP+TCP 3478, TLS 443   -> COTURN_HOSTS entry "<domain>"
#   Rust relay: UDP+TCP 3479, TLS 5349  -> COTURN_HOSTS entry "rs.<domain>:3479:5349"
#
# Without TURN_DOMAIN the relay uses <ip-with-dashes>.sslip.io, which always
# resolves to that IP, so TLS works without touching DNS. Never commit the
# secret: the repository is public.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${TURN_SECRET:?TURN_SECRET is required}"
export DEBIAN_FRONTEND=noninteractive
ARCH="$(dpkg --print-architecture)"   # arm64 on Oracle Ampere, amd64 elsewhere

apt-get update -y
apt-get install -y build-essential pkg-config curl certbot iptables-persistent

PUBLIC_IP="$(curl -fsS4 https://api.ipify.org || curl -fsS4 https://ifconfig.me)"
TURN_DOMAIN="${TURN_DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"
# Its own name, so the app ranks and penalises the two relays separately.
RS_DOMAIN="${RS_DOMAIN:-rs.$TURN_DOMAIN}"

# Toolchains (build only; the relays are static binaries).
GO_VERSION="$(curl -fsS 'https://go.dev/VERSION?m=text' | head -1)"
if ! /usr/local/go/bin/go version 2>/dev/null | grep -q "$GO_VERSION"; then
  curl -fsSL "https://go.dev/dl/${GO_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tgz
  rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz
fi
if [[ ! -x "$HOME/.cargo/bin/cargo" ]]; then
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
(cd go && CGO_ENABLED=0 /usr/local/go/bin/go build -trimpath -ldflags='-s -w' -o /usr/local/bin/televo-turn-go .)
(cd rust && "$HOME/.cargo/bin/cargo" build --release && install -m 755 target/release/televo-turn-rs /usr/local/bin/televo-turn-rs)

id televo-turn >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin televo-turn
install -d -m 750 -o root -g televo-turn /etc/televo-turn
umask 077
printf '%s\n' "$TURN_SECRET" > /etc/televo-turn/secret
umask 022

# Kernel: big UDP buffers for media bursts; outgoing connections stay below
# the relay port range so they never collide with relay allocations.
cat > /etc/sysctl.d/90-televo-turn.conf <<CONF
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576
net.core.netdev_max_backlog = 16384
net.ipv4.ip_local_port_range = 10000 39999
CONF
sysctl --system >/dev/null

# Oracle's Ubuntu image rejects everything but SSH; open the relay ports in
# front of that REJECT rule and keep them across reboots.
for rule in "-p udp --dport 3478" "-p tcp --dport 3478" "-p udp --dport 3479" "-p tcp --dport 3479" \
            "-p tcp --dport 443" "-p tcp --dport 5349" "-p tcp --dport 80" \
            "-p udp --dport 40000:49999" "-p udp --dport 50000:65535"; do
  # shellcheck disable=SC2086
  iptables -C INPUT $rule -j ACCEPT 2>/dev/null || iptables -I INPUT 1 $rule -j ACCEPT
done
netfilter-persistent save

# Behind cloud 1:1 NAT the public IP isn't on any interface. Putting it on
# lo makes relay-to-relay traffic between two phones on this same server
# stay inside the box instead of depending on the cloud hairpinning it.
cat > /etc/systemd/system/televo-turn-hairpin.service <<UNIT
[Unit]
Description=Public IP on lo for Televo TURN relay-to-relay traffic
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'ip addr show dev lo | grep -q " ${PUBLIC_IP}/32" || ip addr add ${PUBLIC_IP}/32 dev lo'
[Install]
WantedBy=multi-user.target
UNIT

# Certificate for TURN over TLS; certbot answers on port 80 itself. The
# relays reload it on renewal, so renewing never drops a call.
install -d -m 750 -o root -g televo-turn /etc/televo-turn/tls
TLS_OK=0
if certbot certonly --standalone --non-interactive --agree-tos --register-unsafely-without-email \
     --keep-until-expiring --cert-name televo-turn -d "$TURN_DOMAIN" -d "$RS_DOMAIN"; then
  TLS_OK=1
  cat > /etc/letsencrypt/renewal-hooks/deploy/televo-turn.sh <<HOOK
#!/bin/sh
install -m 640 -o root -g televo-turn /etc/letsencrypt/live/televo-turn/fullchain.pem /etc/televo-turn/tls/fullchain.pem
install -m 640 -o root -g televo-turn /etc/letsencrypt/live/televo-turn/privkey.pem /etc/televo-turn/tls/privkey.pem
HOOK
  chmod 755 /etc/letsencrypt/renewal-hooks/deploy/televo-turn.sh
  /etc/letsencrypt/renewal-hooks/deploy/televo-turn.sh
else
  echo "WARNING: no certificate for $TURN_DOMAIN — TLS disabled, UDP/TCP only." >&2
fi

unit() { # name binary metrics udp/tcp tls min max realm
  local tls_args=""
  if [[ $TLS_OK == 1 ]]; then
    tls_args="--tls 0.0.0.0:$5 --cert /etc/televo-turn/tls/fullchain.pem --key /etc/televo-turn/tls/privkey.pem"
  fi
  cat > "/etc/systemd/system/$1.service" <<UNIT
[Unit]
Description=Televo TURN relay ($1)
After=network-online.target televo-turn-hairpin.service
Wants=network-online.target televo-turn-hairpin.service

[Service]
Type=notify
NotifyAccess=main
WatchdogSec=15
Restart=always
RestartSec=1
User=televo-turn
Group=televo-turn
LoadCredential=secret:/etc/televo-turn/secret
ExecStart=/usr/local/bin/$2 --realm $8 --external-ip $PUBLIC_IP --udp 0.0.0.0:$4 --tcp 0.0.0.0:$4 $tls_args --min-port $6 --max-port $7 --metrics $3
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
LimitNOFILE=1048576
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK

[Install]
WantedBy=multi-user.target
UNIT
}
unit televo-turn-go televo-turn-go 127.0.0.1:9478 3478 443 50000 65535 "$TURN_DOMAIN"
unit televo-turn-rs televo-turn-rs 127.0.0.1:9479 3479 5349 40000 49999 "$RS_DOMAIN"

systemctl daemon-reload
systemctl enable --now televo-turn-hairpin.service
systemctl enable televo-turn-go televo-turn-rs
systemctl restart televo-turn-go televo-turn-rs
sleep 4
for svc in go:9478 rs:9479; do
  echo "televo-turn-${svc%%:*}: $(curl -fsS "http://127.0.0.1:${svc##*:}/healthz" || echo DOWN)"
done
echo "Domain: $TURN_DOMAIN  (TLS: $([[ $TLS_OK == 1 ]] && echo on || echo off))"
echo "COTURN_HOSTS=$TURN_DOMAIN,$RS_DOMAIN:3479:5349"
