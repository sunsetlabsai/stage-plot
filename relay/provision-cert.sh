#!/usr/bin/env bash
# Conductor 3b chunk 6: relay cert provisioning (design-conductor-3b §1a, §10-6).
#
# The relay must speak wss:// with a PUBLICLY VALID certificate, because the
# PWA is served over https and browsers block ws:// (mixed content) and reject
# self-signed certs on a backhaul-less LAN. The locked answer: issue a real
# Let's Encrypt cert for relay.showrunr.ai AT HOME via a DNS-01 challenge,
# carry the cert files to the gig, and let the band AP's DNS answer
# relay.showrunr.ai with the relay box's LAN IP.
#
# Usage:
#   ./relay/provision-cert.sh issue   # interactive DNS-01 issue/renew (needs internet)
#   ./relay/provision-cert.sh check   # expiry check; exit 1 if <30 days or missing
#
# Requires: certbot (brew install certbot) and openssl. No sudo needed —
# certbot state lives under RELAY_CERT_STATE (default ./relay/certs).
set -euo pipefail

DOMAIN="${RELAY_DOMAIN:-relay.showrunr.ai}"
STATE_DIR="${RELAY_CERT_STATE:-$(cd "$(dirname "$0")" && pwd)/certs}"
LIVE_DIR="$STATE_DIR/config/live/$DOMAIN"
CERT="$LIVE_DIR/fullchain.pem"
KEY="$LIVE_DIR/privkey.pem"
MIN_DAYS="${RELAY_CERT_MIN_DAYS:-30}"

print_env_lines() {
  echo
  echo "Point the relay at the cert with:"
  echo "  export RELAY_CERT=\"$CERT\""
  echo "  export RELAY_KEY=\"$KEY\""
}

cmd_issue() {
  command -v certbot >/dev/null || { echo "certbot not found — brew install certbot" >&2; exit 1; }
  echo "Issuing/renewing cert for $DOMAIN via manual DNS-01."
  echo "Certbot will print a TXT record; add it at your DNS host for"
  echo "_acme-challenge.$DOMAIN, wait for propagation, then continue."
  echo
  certbot certonly \
    --manual --preferred-challenges dns \
    -d "$DOMAIN" \
    --config-dir "$STATE_DIR/config" \
    --work-dir "$STATE_DIR/work" \
    --logs-dir "$STATE_DIR/logs" \
    --no-eff-email
  echo
  echo "Issued. Cert files:"
  echo "  $CERT"
  echo "  $KEY"
  print_env_lines
}

cmd_check() {
  command -v openssl >/dev/null || { echo "openssl not found" >&2; exit 1; }
  if [[ ! -f "$CERT" || ! -f "$KEY" ]]; then
    echo "NO CERT for $DOMAIN under $LIVE_DIR — run: $0 issue" >&2
    exit 1
  fi
  local end_date end_epoch now_epoch days_left
  end_date=$(openssl x509 -enddate -noout -in "$CERT" | cut -d= -f2)
  # macOS (BSD date) first, GNU date fallback.
  end_epoch=$(date -j -f "%b %e %T %Y %Z" "$end_date" +%s 2>/dev/null \
    || date -d "$end_date" +%s)
  now_epoch=$(date +%s)
  days_left=$(( (end_epoch - now_epoch) / 86400 ))
  echo "Cert for $DOMAIN expires: $end_date ($days_left days left)"
  if (( days_left < MIN_DAYS )); then
    echo "EXPIRING SOON (<$MIN_DAYS days) — run: $0 issue" >&2
    exit 1
  fi
  echo "OK — good for the next $MIN_DAYS+ days."
  print_env_lines
}

case "${1:-}" in
  issue) cmd_issue ;;
  check) cmd_check ;;
  *) echo "usage: $0 {issue|check}" >&2; exit 2 ;;
esac
