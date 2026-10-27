#!/bin/sh
# Read-only checks. Health requests do not run the model.
set -eu
systemctl is-active --quiet tomorrow-agent tomorrow-api tomorrow-worker
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8090/health
printf '\n'
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8080/v1/health
printf '\n'
public_base=${TOMORROW_PUBLIC_BASE_URL:-http://127.0.0.1}
proxy_health=$(curl --fail --silent --show-error --max-time 5 "$public_base/v1/health")
case "$proxy_health" in
    *'"ok":true'*) printf '%s\n' "$proxy_health" ;;
    *) echo 'The public proxy did not return the API health response.' >&2; exit 1 ;;
esac
# Public proxy must not route internal operations.
status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "$public_base/internal/agent/runs/check/state")
if [ "$status" != 404 ]; then
    echo "Internal endpoint is unexpectedly routed (HTTP $status)." >&2
    exit 1
fi
echo 'Local services are active and health endpoints respond; model/task behavior needs a separate authenticated smoke check.'
