#!/usr/bin/env bash
# Creates a Cloudflare Access service token for one application, admits it
# with a policy of its own on the Capitoline Access application, and binds
# its client id to the application's name in the gateway, so /v1/usage reads
# the name and not the id (docs/connecting-an-application.md, "A Cloudflare service token").
#
#   CF_API_TOKEN=... CF_ACCOUNT_ID=... CF_ACCESS_APP_ID=... \
#   CAPITOLINE_URL=https://api.example.com CAPITOLINE_ADMIN_KEY=cap_... \
#   scripts/cf-service-token.sh <app-name>
#
# Runs where the owner is, never on the gateway host: CF_API_TOKEN needs
# "Access: Service Tokens Write" and "Access: Apps and Policies Write", and a
# credential that can rewrite who may reach the gateway does not belong on
# the process that faces the internet (design §13). CAPITOLINE_ADMIN_KEY is
# a gateway key whose name is in server.access.admins (or omit it, together
# with CAPITOLINE_URL, to skip the binding and do it by hand).
#
# Prints the two headers the application stores (docs/connecting-an-application.md §3), once:
# Cloudflare shows the secret at creation and never again. Nothing else is
# printed, and neither the secret nor CF_API_TOKEN reaches a log.
set -euo pipefail
[[ $# -eq 1 ]] || { echo "usage: $0 <app-name>" >&2; exit 2; }
NAME="$1"
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{1,63}$ ]] || { echo "app name: lower case, digits and dashes, 2-64 characters" >&2; exit 2; }
: "${CF_API_TOKEN:?set CF_API_TOKEN, a Cloudflare API token with Access Service Tokens Write and Access Apps and Policies Write}"
: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}"
: "${CF_ACCESS_APP_ID:?set CF_ACCESS_APP_ID, the id of the Capitoline Access application}"
API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access"

cf() { # method path [json-body]
  local method="$1" path="$2" body="${3:-}"
  local out
  if [[ -n "$body" ]]; then
    out=$(curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $CF_API_TOKEN" -H 'content-type: application/json' -d "$body")
  else
    out=$(curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $CF_API_TOKEN")
  fi
  if [[ "$(jq -r '.success' <<<"$out")" != "true" ]]; then
    echo "cloudflare $method $path failed: $(jq -c '.errors' <<<"$out")" >&2
    return 1
  fi
  printf '%s' "$out"
}

# One token and one policy per application, never a second copy under the
# same name: an existing one is an error to look at, not something to add to.
existing_tokens=$(cf GET "/service_tokens" | jq -r --arg n "$NAME" '[.result[] | select(.name == $n)] | length')
if [[ "$existing_tokens" != "0" ]]; then
  echo "a service token named \"$NAME\" already exists; revoke it first or pick another name" >&2; exit 1
fi
existing_policies=$(cf GET "/apps/$CF_ACCESS_APP_ID/policies" | jq -r --arg n "$NAME" '[.result[] | select(.name == $n)] | length')
if [[ "$existing_policies" != "0" ]]; then
  echo "the application already has a policy named \"$NAME\"" >&2; exit 1
fi

# 1. The token. One year: a token with no expiry is one nobody revisits.
token_body=$(jq -n --arg n "$NAME" '{name: $n, duration: "8760h"}')
token=$(cf POST "/service_tokens" "$token_body")
token_id=$(jq -r '.result.id' <<<"$token")
client_id=$(jq -r '.result.client_id' <<<"$token")
client_secret=$(jq -r '.result.client_secret' <<<"$token")

# 2. The policy, on the Capitoline application: Service Auth, this token only.
policy_body=$(jq -n --arg n "$NAME" --arg t "$token_id" '{name: $n, decision: "non_identity", precedence: 100, include: [{service_token: {token_id: $t}}]}')
cf POST "/apps/$CF_ACCESS_APP_ID/policies" "$policy_body" > /dev/null

# 3. The binding: the gateway calls this client id by the application's name.
if [[ -n "${CAPITOLINE_URL:-}" && -n "${CAPITOLINE_ADMIN_KEY:-}" ]]; then
  bind_body=$(jq -n --arg n "$NAME" '{name: $n}')
  bind_out=$(mktemp); trap 'rm -f "$bind_out"' EXIT
  bind_code=$(curl -sS -X PUT "$CAPITOLINE_URL/v1/admin/callers/$client_id" -H "Authorization: Bearer $CAPITOLINE_ADMIN_KEY" \
    -H 'content-type: application/json' -d "$bind_body" -o "$bind_out" -w '%{http_code}' || echo 000)
  if [[ "$bind_code" != "200" ]]; then
    echo "binding at the gateway failed (HTTP $bind_code): $(cat "$bind_out")" >&2
    echo "bind by hand: PUT $CAPITOLINE_URL/v1/admin/callers/$client_id with {\"name\":\"$NAME\"}" >&2
  fi
else
  echo "not bound at the gateway: CAPITOLINE_URL or CAPITOLINE_ADMIN_KEY unset. Bind with PUT /v1/admin/callers/$client_id and {\"name\":\"$NAME\"}, or server.access.callers in the overlay" >&2
fi

# 4. The headers the application stores. Shown once.
printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n' "$client_id" "$client_secret"
