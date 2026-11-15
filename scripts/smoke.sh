#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Signs up two users over HTTP and proves one can't delete the other's item (the template's example), then walks the
# event-ticketing foundation: an organiser creates, publishes and lists an event, door staff accept an invite and lose
# access when removed, and an admin hides and unhides it. Needs jq and an organiser account:
#   SMOKE_ORGANIZER_EMAIL / SMOKE_ORGANIZER_PASSWORD (CI seeds them; live uses repo secrets; the run fails without them)
#   SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD (optional: the admin steps are skipped, and say so, when unset)
#   BASE_URL=https://app15.breakthruventures.ai ./scripts/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"; JAR_O="$(mktemp)"; JAR_C="$(mktemp)"; JAR_ADM="$(mktemp)"; RESP="$(mktemp)"
EVENT_ID=""

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

# req JAR METHOD PATH [JSON]: sets $STATUS and $BODY. A cookie jar that holds no session is fine for public calls.
req() {
  local jar=$1 method=$2 path=$3 body=${4:-}
  if [ -n "$body" ]; then
    STATUS=$(curl -s -o "$RESP" -w '%{http_code}' -X "$method" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "$body" "$BASE_URL$path")
  else
    STATUS=$(curl -s -o "$RESP" -w '%{http_code}' -X "$method" -b "$jar" -H "origin: $BASE_URL" "$BASE_URL$path")
  fi
  BODY=$(cat "$RESP")
}
expect() { # expect STATUS WHAT: fail unless $STATUS matches
  [ "$STATUS" = "$1" ] || fail "$2: expected HTTP $1, got $STATUS ($BODY)"
}

# Whatever happens, cancel and delete the event this run made, so the organiser's 20-event cap never fills across runs.
cleanup() {
  set +e
  if [ -n "$EVENT_ID" ]; then
    req "$JAR_O" GET "/api/organizer/events/$EVENT_ID"
    if [ "$STATUS" = "200" ]; then
      ver=$(echo "$BODY" | jq -r '.event.version'); st=$(echo "$BODY" | jq -r '.event.status')
      [ "$st" = "published" ] && req "$JAR_O" PATCH "/api/organizer/events/$EVENT_ID" "{\"version\":$ver,\"status\":\"cancelled\"}"
      req "$JAR_O" DELETE "/api/organizer/events/$EVENT_ID"
    fi
  fi
  rm -f "$JAR_A" "$JAR_B" "$JAR_O" "$JAR_C" "$JAR_ADM" "$RESP"
}
trap cleanup EXIT

command -v jq >/dev/null || fail "jq is required"
[ -n "${SMOKE_ORGANIZER_EMAIL:-}" ] && [ -n "${SMOKE_ORGANIZER_PASSWORD:-}" ] || fail "SMOKE_ORGANIZER_EMAIL and SMOKE_ORGANIZER_PASSWORD are required"
uuid() { cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen; }
iso_in() { date -u -d "+$1 seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+"$1"S +%Y-%m-%dT%H:%M:%SZ; }

health=$(curl -fsS "$BASE_URL/api/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "health not ok: $health"
pass "health check"

for path in / /sign-in; do
  page=$(curl -fsS "$BASE_URL$path") || fail "page $path did not render"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "page $path is missing the shared footer"
done
pass "pages render inside the shared shell"

for path in /dashboard /admin; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out dashboard and admin redirect"

# Better Auth allows 3 sign-in/sign-up requests per 10 s per IP. Back-to-back runs (smoke right after seeding, or two
# users in a row) can hit it. On a 429, wait out the window and retry once.
post_auth() {
  local jar=$1 path=$2 payload=$3 code
  for attempt in 1 2; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
      -d "$payload" "$BASE_URL$path")
    if [ "$code" = "429" ] && [ "$attempt" = "1" ]; then
      echo "auth rate limit (429) on $path; waiting 11s and retrying once"
      sleep 11
      continue
    fi
    break
  done
  case "$code" in 2??) return 0 ;; *) echo "auth request to $path returned $code" >&2; return 1 ;; esac
}

signup() {
  local jar=$1 email=$2
  post_auth "$jar" /api/auth/sign-up/email "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" || fail "sign-up failed for $email"
}

signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
pass "two users signed up"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/items")
[ "$code" = "401" ] || fail "anonymous list should be 401, got $code"
pass "anonymous access refused"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H 'origin: https://evil.example' \
  -d '{"title":"x"}' "$BASE_URL/api/items")
[ "$code" = "403" ] || fail "cross-origin create should be 403, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' \
  -d '{"title":"x"}' "$BASE_URL/api/items")
[ "$code" = "403" ] || fail "create without an Origin should be 403, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{nope' "$BASE_URL/api/items")
[ "$code" = "400" ] || fail "malformed JSON should be 400, got $code"
code=$(head -c 40000 /dev/zero | tr '\0' 'x' | curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  --data-binary @- "$BASE_URL/api/items")
[ "$code" = "413" ] || fail "oversized body should be 413, got $code"
pass "cross-origin, malformed and oversized writes refused"

item=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"title":"smoke item"}' "$BASE_URL/api/items") || fail "create item failed"
id=$(echo "$item" | sed -E 's/.*"id":"([^"]+)".*/\1/')
[ -n "$id" ] || fail "no item id in $item"
pass "user A created an item"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"title":"nul\u0000byte"}' "$BASE_URL/api/items")
[ "$code" = "400" ] || fail "a NUL byte in a title should be 400, got $code"
pass "NUL byte rejected with 400, not 500"

op="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)"
first=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"title\":\"smoke replay\",\"clientOpId\":\"$op\"}" "$BASE_URL/api/items") || fail "idempotent create failed"
second=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"title\":\"smoke replay\",\"clientOpId\":\"$op\"}" "$BASE_URL/api/items") || fail "idempotent replay failed"
replay_id=$(echo "$first" | sed -E 's/.*"id":"([^"]+)".*/\1/')
[ "$replay_id" = "$(echo "$second" | sed -E 's/.*"id":"([^"]+)".*/\1/')" ] || fail "a replayed op id must return the first item: $first vs $second"
curl -fsS -X DELETE -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/items/$replay_id" >/dev/null || fail "cleanup of the replay item failed"
pass "replaying a client op id returns the same item"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -b "$JAR_B" -H "origin: $BASE_URL" "$BASE_URL/api/items/$id")
[ "$code" = "403" ] || fail "user B deleting A's item should be 403, got $code"
pass "user B blocked from A's item"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/ai/summarize")
[ "$code" = "200" ] || fail "AI summary should be 200, got $code"
pass "AI summary responds"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/items/$id")
[ "$code" = "204" ] || fail "owner delete should be 204, got $code"
pass "owner deleted their item"

# ---------------------------------------------------------------------------
# Event ticketing foundation (spec 15.1): organiser, public reads, door staff, admin.
# ---------------------------------------------------------------------------
post_auth "$JAR_O" /api/auth/sign-in/email "{\"email\":\"$SMOKE_ORGANIZER_EMAIL\",\"password\":\"$SMOKE_ORGANIZER_PASSWORD\"}" || fail "organiser sign-in failed"
signup "$JAR_C" "smoke-c-$RUN_ID@example.test"
pass "organiser signed in, staff user signed up"

req "$JAR_A" GET /api/organizer/events; expect 403 "an attendee on the organiser list"
req /dev/null GET /api/organizer/events; expect 401 "anonymous on the organiser list"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_O" -H 'content-type: application/json' -d '{"title":"x"}' "$BASE_URL/api/organizer/events")
[ "$code" = "403" ] || fail "organiser create without an Origin should be 403, got $code"
req "$JAR_O" GET /api/organizer/events/not-a-uuid; expect 400 "a malformed event id"
req "$JAR_O" GET "/api/organizer/events/00000000-0000-4000-8000-000000000000"; expect 404 "an unknown event id"
pass "organiser routes refuse attendees, anonymous callers, missing Origin, malformed and unknown ids"

OP="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)"
EVENT_JSON="{\"title\":\"Smoke meetup $RUN_ID\",\"venueName\":\"Smoke Hall\",\"timeZone\":\"America/Chicago\",\"startsAt\":\"$(iso_in 3600)\",\"endsAt\":\"$(iso_in 10800)\",\"clientOpId\":\"$OP\"}"
req "$JAR_O" POST /api/organizer/events "$EVENT_JSON"; expect 201 "create event"
EVENT_ID=$(echo "$BODY" | jq -r '.event.id'); SLUG=$(echo "$BODY" | jq -r '.event.slug')
[ -n "$EVENT_ID" ] && [ "$EVENT_ID" != "null" ] || fail "no event id in $BODY"
req "$JAR_O" POST /api/organizer/events "$EVENT_JSON"; expect 200 "replayed create"
[ "$(echo "$BODY" | jq -r '.event.id')" = "$EVENT_ID" ] && [ "$(echo "$BODY" | jq -r '.created')" = "false" ] || fail "a replayed client op id must return the first event: $BODY"
NUL_JSON=$(printf '%s' "$EVENT_JSON" | sed 's/Smoke meetup/nul\\u0000byte/')
req "$JAR_O" POST /api/organizer/events "$NUL_JSON"; expect 400 "a NUL byte in a title"
pass "organiser created an event; the same client op id returned it again"

req "$JAR_O" PATCH "/api/organizer/events/$EVENT_ID" '{"version":1,"status":"published"}'; expect 409 "publishing without a ticket type"
[ "$(echo "$BODY" | jq -r '.code')" = "no_ticket_types" ] || fail "expected code no_ticket_types: $BODY"
req "$JAR_O" POST "/api/organizer/events/$EVENT_ID/ticket-types" '{"name":"General","capacity":2}'; expect 201 "add a ticket type"
req "$JAR_O" PATCH "/api/organizer/events/$EVENT_ID" '{"version":99,"title":"Stale"}'; expect 409 "a stale version"
req "$JAR_A" GET "/api/events/by-slug/$SLUG"; expect 404 "a draft event on the public page"
req "$JAR_O" PATCH "/api/organizer/events/$EVENT_ID" '{"version":1,"status":"published"}'; expect 200 "publish"
pass "publish needs a ticket type, a stale version is refused, drafts are not public"

req /dev/null GET /api/events; expect 200 "public event list"
echo "$BODY" | jq -e --arg id "$EVENT_ID" '.events | map(.id) | index($id) != null' >/dev/null || fail "the published event is not in /api/events"
req /dev/null GET "/api/events/by-slug/$SLUG"; expect 200 "event by slug"
[ "$(echo "$BODY" | jq -r '.ticketTypes[0].seatsLeft')" = "2" ] || fail "expected 2 seats left: $BODY"
echo "$BODY" | jq -e '.event | has("organizerId") or has("clientOpId") or has("hiddenReason") | not' >/dev/null || fail "the public event leaks a private field: $BODY"
req /dev/null GET "/api/events/by-slug/no-such-event-$RUN_ID"; expect 404 "an unknown slug"
pass "the published event is listed and opens by slug with seats left"

INVITE_OP="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)"
req "$JAR_O" POST "/api/organizer/events/$EVENT_ID/staff/invites" "{\"clientOpId\":\"$INVITE_OP\"}"; expect 201 "create an invite"
INVITE_ID=$(echo "$BODY" | jq -r '.id'); LINK=$(echo "$BODY" | jq -r '.link')
req "$JAR_O" POST "/api/organizer/events/$EVENT_ID/staff/invites" "{\"clientOpId\":\"$INVITE_OP\"}"; expect 200 "replayed invite"
[ "$(echo "$BODY" | jq -r '.id')" = "$INVITE_ID" ] && [ "$(echo "$BODY" | jq -r '.link')" = "$LINK" ] || fail "a replayed invite must return the same invite and link: $BODY"
case "$LINK" in *"/staff-invite#t="*) ;; *) fail "the invite link must carry the token in the fragment: $LINK" ;; esac
TOKEN="${LINK#*#t=}"
req "$JAR_B" POST /api/staff-invites/accept "{\"token\":\"$TOKEN\"}"; expect 200 "accept the invite"
req "$JAR_C" POST /api/staff-invites/accept "{\"token\":\"$TOKEN\"}"; expect 404 "accept a used invite"
USED_BODY=$BODY
req "$JAR_C" POST /api/staff-invites/accept '{"token":"never-issued"}'; expect 404 "accept an unknown invite"
[ "$BODY" = "$USED_BODY" ] || fail "a used and an unknown token must answer identically: $USED_BODY vs $BODY"
req "$JAR_B" GET /api/door/events; expect 200 "door events for staff"
echo "$BODY" | jq -e --arg id "$EVENT_ID" '.events | map(.id) | index($id) != null' >/dev/null || fail "staff don't see the event at the door: $BODY"
req "$JAR_C" GET /api/door/events
echo "$BODY" | jq -e --arg id "$EVENT_ID" '.events | map(.id) | index($id) == null' >/dev/null || fail "a stranger sees the event at the door: $BODY"
STAFF_ID=$(curl -fsS -b "$JAR_O" "$BASE_URL/api/organizer/events/$EVENT_ID/staff" | jq -r '.staff[0].userId')
[ -n "$STAFF_ID" ] && [ "$STAFF_ID" != "null" ] || fail "the organiser's staff list is empty"
REMOVE_OP="$(uuid)"
req "$JAR_O" DELETE "/api/organizer/events/$EVENT_ID/staff/$STAFF_ID" '{}'; expect 400 "removing staff without a client op id"
req "$JAR_O" DELETE "/api/organizer/events/$EVENT_ID/staff/$STAFF_ID" "{\"clientOpId\":\"$REMOVE_OP\"}"; expect 200 "remove staff"
req "$JAR_O" DELETE "/api/organizer/events/$EVENT_ID/staff/$STAFF_ID" "{\"clientOpId\":\"$REMOVE_OP\"}"; expect 200 "replayed removal"
[ "$(echo "$BODY" | jq -r '.replayed')" = "true" ] || fail "a replayed removal must say so: $BODY"
req "$JAR_B" GET /api/door/events
echo "$BODY" | jq -e --arg id "$EVENT_ID" '.events | map(.id) | index($id) == null' >/dev/null || fail "a removed staffer still sees the door: $BODY"
req "$JAR_B" GET "/api/organizer/events/$EVENT_ID/staff"; expect 403 "staff on the organiser's staff list"
pass "invite works once and answers the same for unknown and used tokens; removal closes the door"

if [ -n "${SMOKE_ADMIN_EMAIL:-}" ] && [ -n "${SMOKE_ADMIN_PASSWORD:-}" ]; then
  post_auth "$JAR_ADM" /api/auth/sign-in/email "{\"email\":\"$SMOKE_ADMIN_EMAIL\",\"password\":\"$SMOKE_ADMIN_PASSWORD\"}" || fail "admin sign-in failed"
  req "$JAR_ADM" GET /api/admin/stats; expect 200 "admin stats"
  echo "$BODY" | jq -e '.events.byStatus.published >= 1 and (.users | has("organizer"))' >/dev/null || fail "unexpected admin stats: $BODY"
  req "$JAR_O" GET /api/admin/stats; expect 403 "the organiser on admin stats"
  req "$JAR_ADM" GET "/api/organizer/events/$EVENT_ID"; expect 403 "an admin reading organiser content"
  req "$JAR_ADM" POST "/api/admin/events/$EVENT_ID/hide" "{\"hidden\":true,\"clientOpId\":\"$(uuid)\"}"; expect 400 "hiding without a reason"
  req "$JAR_ADM" POST "/api/admin/events/$EVENT_ID/hide" '{"hidden":true,"reason":"smoke test"}'; expect 400 "hiding without a client op id"
  req "$JAR_ADM" POST "/api/admin/events/$EVENT_ID/hide" "{\"hidden\":true,\"reason\":\"smoke test\",\"clientOpId\":\"$(uuid)\"}"; expect 200 "hide"
  req /dev/null GET "/api/events/by-slug/$SLUG"; expect 404 "a hidden event on the public page"
  UNHIDE_OP="$(uuid)"
  req "$JAR_ADM" POST "/api/admin/events/$EVENT_ID/hide" "{\"hidden\":false,\"clientOpId\":\"$UNHIDE_OP\"}"; expect 200 "unhide"
  req "$JAR_ADM" POST "/api/admin/events/$EVENT_ID/hide" "{\"hidden\":false,\"clientOpId\":\"$UNHIDE_OP\"}"; expect 200 "replayed unhide"
  [ "$(echo "$BODY" | jq -r '.replayed')" = "true" ] || fail "a replayed unhide must say so: $BODY"
  req /dev/null GET "/api/events/by-slug/$SLUG"; expect 200 "an unhidden event on the public page"
  for path in /admin/set-role /admin/create-user /admin/update-user /admin/remove-user; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_ADM" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"userId":"x","role":"admin"}' "$BASE_URL/api/auth$path")
    case "$code" in 403|404) ;; *) fail "$path should be 403 or 404 for an admin, got $code" ;; esac
  done
  ROLE_OP="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)"
req "$JAR_ADM" POST /api/admin/roles '{"userId":"smoke-nobody","role":"organizer","from":"user"}'; expect 400 "a role change without a client op id"
req "$JAR_ADM" POST /api/admin/roles "{\"userId\":\"smoke-nobody\",\"role\":\"organizer\",\"from\":\"user\",\"clientOpId\":\"$ROLE_OP\"}"; expect 404 "granting to an unknown user"
  pass "admin sees counts, hides and unhides an event, and Better Auth's role and account writes are refused"
else
  echo "skip - admin steps (SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD not set)"
fi

echo "SMOKE PASS"
