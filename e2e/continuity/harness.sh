#!/usr/bin/env bash
# Disposable Homebase test host for the Feature 13 continuity acceptance drill.
#
# Builds what docs/continuity-phase-c-acceptance-runbook.md §4-§5 describe, minus the tailnet:
#   - hs-mailpit: SMTP relay (STARTTLS required, any auth accepted) + inbox API on 127.0.0.1:8025
#   - hs-host:    privileged systemd Ubuntu 24.04 container; Homebase installed by its own
#                 install.sh, Home Source installed by the Homebase executor from a local bare
#                 clone of this repository, gateway published on 127.0.0.1:443
#
# Usage: e2e/continuity/harness.sh up|install|app|configure|status|reset|down|all
#   HS_E2E_SOURCE=<git checkout> HS_E2E_REF=<ref> selects what Homebase installs (default: this repo, main)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
STATE="${HS_E2E_STATE:-$HERE/.state}"
HOMEBASE_DIR="${HOMEBASE_DIR:-$(cd "$REPO/../homeBase" 2>/dev/null && pwd || true)}"
SOURCE="${HS_E2E_SOURCE:-$REPO}"
REF="${HS_E2E_REF:-main}"
IMAGE="${HS_E2E_IMAGE:-homebase-vm:24.04}"
NETWORK=hs-e2e
HOST=hs-host
MAILPIT=hs-mailpit
APP_DIR=/opt/sovereign-home/apps/homeSource

log() { printf '[harness] %s\n' "$*"; }
die() { printf '[harness] ERROR: %s\n' "$*" >&2; exit 1; }
in_host() { docker exec "$HOST" bash -c "$1"; }

ensure_image() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 && return
  log "building $IMAGE"
  docker build -t "$IMAGE" -f "$HERE/Dockerfile.host" "$HERE"
}

cmd_up() {
  mkdir -p "$STATE"
  ensure_image
  if [ ! -f "$STATE/smtp.crt" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=mailpit" \
      -addext "subjectAltName=DNS:mailpit" -keyout "$STATE/smtp.key" -out "$STATE/smtp.crt" 2>/dev/null
    chmod 644 "$STATE/smtp.key"
  fi
  docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
  docker rm -f "$MAILPIT" "$HOST" >/dev/null 2>&1 || true
  docker run -d --name "$MAILPIT" --network "$NETWORK" --network-alias mailpit \
    -p 127.0.0.1:8025:8025 \
    -v "$STATE/smtp.crt:/certs/smtp.crt:ro" -v "$STATE/smtp.key:/certs/smtp.key:ro" \
    -e MP_SMTP_TLS_CERT=/certs/smtp.crt -e MP_SMTP_TLS_KEY=/certs/smtp.key \
    -e MP_SMTP_BIND_ADDR=0.0.0.0:587 -e MP_SMTP_REQUIRE_STARTTLS=true -e MP_SMTP_AUTH_ACCEPT_ANY=true -e MP_MAX_MESSAGES=5000 \
    axllent/mailpit:v1.27 >/dev/null
  docker run -d --name "$HOST" --hostname hs-test --network "$NETWORK" \
    --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
    -p 127.0.0.1:443:443 "$IMAGE" >/dev/null
  for _ in $(seq 1 30); do
    state="$(docker exec "$HOST" systemctl is-system-running 2>/dev/null || true)"
    case "$state" in running|degraded) break ;; esac
    sleep 1
  done
  log "containers up (host systemd: ${state:-unknown})"
}

cmd_install() {
  [ -n "$HOMEBASE_DIR" ] && git -C "$HOMEBASE_DIR" rev-parse --git-dir >/dev/null 2>&1 || die "set HOMEBASE_DIR to a homeBase checkout or worktree"
  mkdir -p "$STATE"
  log "snapshotting homeBase ($(git -C "$HOMEBASE_DIR" rev-parse --short HEAD))"
  (cd "$HOMEBASE_DIR" && git archive --format=tar.gz --prefix=homeBase/ -o "$STATE/homeBase.tgz" HEAD)
  docker cp "$STATE/homeBase.tgz" "$HOST:/tmp/homeBase.tgz"

  # Drive Home Base's web API inside the host, the way an operator's browser would.
  docker exec -i "$HOST" bash -c 'cat > /usr/local/bin/hb.sh && chmod +x /usr/local/bin/hb.sh' <<'SH'
#!/bin/bash
J=/tmp/hb.cookies
exec curl -s -b $J -c $J -X "$1" -H 'content-type: application/json' ${3:+--data "$3"} "http://127.0.0.1:3080$2"
SH
  docker exec -i "$HOST" bash -c 'cat > /usr/local/bin/job.sh && chmod +x /usr/local/bin/job.sh' <<'SH'
#!/bin/bash
# Start a Home Base job and wait for it. Usage: job.sh <path> [json]
body=${2:-'{"dryRun":false,"confirm":"EXECUTE"}'}
resp=$(/usr/local/bin/hb.sh POST "$1" "$body")
id=$(echo "$resp" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("jobId") or d.get("job",{}).get("id") or "")' 2>/dev/null)
[ -n "$id" ] || { echo "NO JOB: $resp"; exit 1; }
for _ in $(seq 1 900); do
  j=$(/usr/local/bin/hb.sh GET /api/jobs/$id)
  st=$(echo "$j" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("job",d).get("status"))')
  case "$st" in completed|failed|cancelled) break;; esac
  sleep 2
done
echo "$j" | python3 -c '
import sys,json
d=json.load(sys.stdin); d=d.get("job",d)
print("job", d.get("id"), d.get("status"))
for k in ("error","errorCode"):
  if d.get(k): print(k, d[k])
'
[ "$st" = completed ]
SH

  in_host '
set -e
export DEBIAN_FRONTEND=noninteractive
mkdir -p /src
git config --system url."file:///srv/homeSource.git".insteadOf https://github.com/eforbell/homeSource.git
git config --system --add safe.directory "*"
rm -rf /src/homeBase && tar -xzf /tmp/homeBase.tgz -C /src
cd /src/homeBase && git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm snapshot
bash install.sh --source-dir /src/homeBase > /tmp/install.log 2>&1 || { tail -20 /tmp/install.log; exit 1; }
'
  log "homeBase installed; running setup and bootstrap"
  in_host "hb.sh POST /api/admin/setup '{\"passphrase\":\"harness-passphrase\"}' >/dev/null"
  in_host 'job.sh /api/bootstrap/execute'
  cmd_app
}

# Publish $SOURCE's refs as the "GitHub" repository inside the host and have Homebase install
# (or update to) $REF through its executor.
cmd_app() {
  log "snapshotting homeSource $REF from $SOURCE"
  rm -rf "$STATE/homeSource.git"
  git clone -q --bare --no-local "$SOURCE" "$STATE/homeSource.git"
  git -C "$STATE/homeSource.git" rev-parse --verify -q "$REF^{commit}" >/dev/null || die "ref $REF not found in $SOURCE"
  # The executor installs only main or a pinned 40-character commit.
  local install_ref="$REF"
  [ "$REF" = main ] || install_ref="$(git -C "$STATE/homeSource.git" rev-parse "$REF^{commit}")"
  COPYFILE_DISABLE=1 tar --no-xattrs -C "$STATE" -czf "$STATE/homeSource.git.tgz" homeSource.git
  docker cp "$STATE/homeSource.git.tgz" "$HOST:/tmp/homeSource.git.tgz"
  in_host 'mkdir -p /srv && rm -rf /srv/homeSource.git && tar -xzf /tmp/homeSource.git.tgz -C /srv && chown -R root:root /srv'
  in_host "hb.sh POST /api/admin/unlock '{\"passphrase\":\"harness-passphrase\"}' >/dev/null"
  in_host "job.sh /api/apps/home-source/execute '{\"dryRun\":false,\"confirm\":\"EXECUTE\",\"ref\":\"$install_ref\"}'"
  log "installed home-source $(docker exec "$HOST" git -C $APP_DIR log -1 --format='%h %s')"
}


# The runbook's §4.3 operator edit of the Homebase-managed .env. APP_URL is the gateway as the
# test browser sees it (no tailnet). SMTP points at Mailpit with STARTTLS required; the relay's
# certificate is self-signed, so certificate verification is the one deliberate relaxation.
cmd_configure() {
  in_host "
set -e
cd $APP_DIR
sed -i -E \
  -e 's#^APP_URL=.*#APP_URL=https://localhost/source/#' \
  -e 's#^MAIL_TRANSPORT=.*#MAIL_TRANSPORT=smtp#' \
  -e 's#^SMTP_HOST=.*#SMTP_HOST=mailpit#' \
  -e 's#^SMTP_PORT=.*#SMTP_PORT=587#' \
  -e 's#^SMTP_SECURE=.*#SMTP_SECURE=no#' \
  -e 's#^SMTP_REQUIRE_TLS=.*#SMTP_REQUIRE_TLS=yes#' \
  -e 's#^SMTP_USER=.*#SMTP_USER=hs-relay#' \
  -e 's#^SMTP_PASS=.*#SMTP_PASS=relay-test-only#' \
  -e 's#^SMTP_FROM=.*#SMTP_FROM=\"Home Source Test <hs-test@hs.test>\"#' \
  -e 's#^SMTP_REJECT_UNAUTHORIZED=.*#SMTP_REJECT_UNAUTHORIZED=no#' \
  -e 's#^NOTIFICATION_TO=.*#NOTIFICATION_TO=hs-owner-test@hs.test#' \
  .env
grep -q '^CONTINUITY_ALLOW_INSPECTION_MAIL=' .env && exit 3 || true
systemctl restart home-source
"
  for _ in $(seq 1 30); do
    curl -sfk -4 https://localhost/source/api/ready >/dev/null && { log "gateway ready"; return; }
    sleep 1
  done
  die "home-source did not become ready through the gateway"
}

cmd_status() {
  docker ps --filter "name=$HOST" --filter "name=$MAILPIT" --format '{{.Names}} {{.Status}} {{.Ports}}'
  in_host 'systemctl list-units "home-source*" --all --no-pager --plain; systemctl list-timers "home-source-continuity-*" --no-pager' || true
  for p in api/health api/ready api/bootstrap; do printf '%-14s %s\n' "$p" "$(curl -sk -4 https://localhost/source/$p)"; done
}

# Development convenience between drill attempts: empty the Home Source database, storage, and
# inboxes on the existing host, then re-run migrations. Not part of the acceptance drill.
cmd_reset() {
  in_host "
set -e
systemctl stop home-source home-source-import-worker
PGOPTIONS=--client-min-messages=warning sudo -E -u postgres psql -d homesource -qc 'DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION homesource;'
find /var/lib/sovereign-home/home-source/data -mindepth 2 -delete
cd $APP_DIR && sudo -u sovereign node db/migrate.js >/dev/null
systemctl start home-source home-source-import-worker
"
  curl -s -X DELETE http://127.0.0.1:8025/api/v1/messages >/dev/null
  for _ in $(seq 1 30); do curl -sfk -4 https://localhost/source/api/ready >/dev/null && { log "reset complete"; return; }; sleep 1; done
  die "home-source did not become ready after reset"
}

cmd_down() {
  docker rm -f "$HOST" "$MAILPIT" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  log "removed containers and network"
}

case "${1:-}" in
  up) cmd_up ;;
  install) cmd_install ;;
  app) cmd_app; cmd_configure ;;
  configure) cmd_configure ;;
  status) cmd_status ;;
  reset) cmd_reset ;;
  down) cmd_down ;;
  all) cmd_up; cmd_install; cmd_configure; cmd_status ;;
  *) echo "usage: $0 up|install|app|configure|status|reset|down|all" >&2; exit 2 ;;
esac
