#!/usr/bin/env bash
# From the Mac: install both relays on a VM, test them from here, then point
# the turn-credentials Edge Function at them.
#
#   server/turn/deploy/deploy.sh <public-ip> [ssh-user] [ssh-key]
#
# The shared secret lives in ~/.config/televo-turn/secret (created on first
# run) and is sent over SSH stdin only — never in a command line or the repo.
set -euo pipefail
IP="${1:?usage: deploy.sh <public-ip> [ssh-user] [ssh-key]}"
USER_NAME="${2:-ubuntu}"
KEY="${3:-$HOME/.ssh/televo_turn}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SECRET_FILE="$HOME/.config/televo-turn/secret"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$USER_NAME@$IP")

if [[ ! -s "$SECRET_FILE" ]]; then
  mkdir -p "$(dirname "$SECRET_FILE")"
  (umask 077 && openssl rand -hex 32 > "$SECRET_FILE")
fi

rsync -az --delete -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
  --exclude rust/target --exclude e2e "$HERE/" "$USER_NAME@$IP:televo-turn/"
"${SSH[@]}" 'sudo bash -c "read -r TURN_SECRET && export TURN_SECRET && bash televo-turn/deploy/setup.sh"' < "$SECRET_FILE" | tee /tmp/televo-turn-setup.log
HOSTS="$(grep -o 'COTURN_HOSTS=.*' /tmp/televo-turn-setup.log | tail -1 | cut -d= -f2)"
[[ -n "$HOSTS" ]] || { echo "setup did not finish" >&2; exit 1; }

echo "Testing $HOSTS from this Mac..."
(cd "$HERE/e2e" && TURN_E2E_HOSTS="$HOSTS" TURN_E2E_SECRET_FILE="$SECRET_FILE" go test -count=1 -timeout 300s ./...)

cd "$REPO"
npx supabase functions deploy turn-credentials >/dev/null
ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
(umask 077 && printf 'COTURN_SECRET=%s\nCOTURN_HOSTS=%s\n' "$(cat "$SECRET_FILE")" "$HOSTS" > "$ENV_FILE")
npx supabase secrets set --env-file "$ENV_FILE" >/dev/null
echo "Live: the turn-credentials function now hands out $HOSTS"
