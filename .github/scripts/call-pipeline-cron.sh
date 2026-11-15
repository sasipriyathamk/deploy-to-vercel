#!/usr/bin/env bash
# Call one production cron route. Logs status and numeric counts only.
# Never prints request headers, secrets, or response bodies.
set -euo pipefail

default_url="https://sniper-wallet-tracker.vercel.app"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

normalize_schedule() {
  printf '%s' "${1:-}" | tr -s '[:space:]' ' ' | sed 's/^ //;s/ $//'
}

strip_breaks() {
  printf '%s' "${1:-}" | tr -d '\r\n'
}

route=""
if [ "${EVENT_NAME:-}" = "workflow_dispatch" ]; then
  case "${INPUT_JOB:-}" in
    poll|recheck|gains|archive) route="${INPUT_JOB}" ;;
    *) fail "workflow_dispatch job must be poll, recheck, gains, or archive" ;;
  esac
else
  schedule="$(normalize_schedule "${EVENT_SCHEDULE:-}")"
  case "${schedule}" in
    "2,12,22,32,42,52 * * * *") route="poll" ;;
    "5,20,35,50 * * * *") route="recheck" ;;
    "10,25,40,55 * * * *") route="gains" ;;
    "17 */6 * * *") route="archive" ;;
    *)
      if printf '%s' "${schedule}" | grep -Eq '^[0-9*/, -]+$'; then
        fail "unknown schedule: ${schedule}"
      fi
      fail "unknown schedule"
      ;;
  esac
fi

if [ "${DRY_RUN:-}" = "1" ]; then
  printf 'route=%s\n' "${route}"
  exit 0
fi

cron_secret="$(strip_breaks "${CRON_SECRET:-}")"
if [ -z "${cron_secret}" ]; then
  fail "CRON_SECRET repository secret is not set"
fi

bypass_secret="$(strip_breaks "${VERCEL_AUTOMATION_BYPASS_SECRET:-}")"
base="${APP_URL:-${default_url}}"
base="${base%/}"
case "${base}" in
  https://*@*) fail "APP_URL must not include userinfo" ;;
  https://*) ;;
  *) fail "APP_URL must be an https URL" ;;
esac

url="${base}/api/cron/${route}"
body="$(mktemp)"
hdr="$(mktemp)"
trap 'rm -f "${body}" "${hdr}"' EXIT

if [ -n "${bypass_secret}" ]; then
  printf 'route=%s protection_bypass=sent\n' "${route}"
else
  printf 'route=%s protection_bypass=absent\n' "${route}"
fi

args=(
  --silent
  --show-error
  --max-time 90
  --output "${body}"
  --dump-header "${hdr}"
  --write-out '%{http_code}'
  --request GET
  --header "Authorization: Bearer ${cron_secret}"
  --header "Accept: application/json"
  --header "User-Agent: keel-pipeline-schedule"
)
if [ -n "${bypass_secret}" ]; then
  args+=(--header "x-vercel-protection-bypass: ${bypass_secret}")
fi

set +e
http_code="$(curl "${args[@]}" "${url}")"
curl_status=$?
set -e
if [ "${curl_status}" -ne 0 ]; then
  printf 'route=%s curl_exit=%s summary=no-http-status\n' "${route}" "${curl_status}"
  exit 1
fi

python3 - "${body}" "${hdr}" "${http_code}" <<'PY'
import json
import sys

body_path, header_path, code = sys.argv[1:]
raw = open(body_path, "rb").read()
text = raw.decode("utf-8", "replace")
stripped = text.lstrip().lower()
content_type = ""
location = ""
for line in open(header_path, encoding="utf-8", errors="replace"):
    lowered = line.lower()
    if lowered.startswith("content-type:"):
        content_type = line.split(":", 1)[1].strip()
    elif lowered.startswith("location:"):
        location = line.split(":", 1)[1].strip().lower()

content_type_short = content_type.split(";", 1)[0].strip() or "unknown"
html = (
    "text/html" in content_type.lower()
    or stripped.startswith("<!doctype")
    or stripped.startswith("<html")
    or "<html" in stripped[:800]
)
sso = (
    "vercel.com/sso" in location
    or "vercel.com/login" in location
    or "_vercel_sso" in stripped[:800]
)
print(f"http={code} bytes={len(raw)} content_type={content_type_short}")
if html or sso:
    print("summary=html-login-or-sso")
    sys.exit(1)

def safe_error(value):
    if not isinstance(value, str) or not value or len(value) > 120:
        return False
    lowered = value.lower()
    blocked = ("bearer", "secret", "token", "password", "api-key", "apikey", "postgres://", "://", "eyj")
    if any(part in lowered for part in blocked):
        return False
    return all(32 <= ord(char) < 127 for char in value)

if not (len(code) == 3 and code.isdigit() and code.startswith("2")):
    summary = "non-2xx"
    try:
        data = json.loads(text)
    except Exception:
        data = None
    if isinstance(data, dict):
        err = data.get("error")
        summary = f"error={err}" if safe_error(err) else "non-2xx-json"
    print(f"summary={summary}")
    sys.exit(1)

try:
    data = json.loads(text)
except Exception:
    print("summary=2xx-non-json")
    sys.exit(1)

fields = (
    "wallets",
    "signatures",
    "queued",
    "claimed",
    "done",
    "released",
    "failed",
    "pending",
    "updated",
    "archived",
    "revived",
    "promoted",
    "aiStored",
    "aiSkipped",
    "aiAttempted",
)

def take(prefix, obj, parts):
    if not isinstance(obj, dict):
        return
    for key in fields:
        value = obj.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if isinstance(value, float) and not value.is_integer():
            continue
        parts.append(f"{prefix}{key}={int(value)}")

parts = []
if isinstance(data, dict):
    take("", data, parts)
    take("polled_", data.get("polled"), parts)
    take("queue_", data.get("queue"), parts)
    if "error" in data:
        parts.append("error_present=true")
print("summary=" + (" ".join(parts) if parts else "ok"))
PY
