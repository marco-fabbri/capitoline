# Connecting an application to Capitoline

For whoever is wiring an application to the gateway, not for whoever built
it: the procedure for the first application and for the next one.

Read `docs/terms-of-service.md` first, or at least its four conditions
(**The line, and four conditions**), and `docs/deployment-policy.md`, the
rules the author's own installation follows. They decide what a credential may
be used for, and the answer is not "anything the gateway will serve".

The examples below use `api.example.com` for the gateway's public host and
`app-one` for the application: put your own in their place.

## One credential per application

Every application gets a credential of its own. Never a shared one, and never
the owner's.

Three reasons, all practical. A credential is revoked alone, so a leak in one
application costs that application and nothing else. Every usage row records
the calling application's name, so `GET /v1/usage` tells two applications
apart and a subscription that is suddenly exhausted has a culprit. And an
application whose behaviour changes can be cut off without touching anything
else.

## The credential: a key from the gateway

Identity belongs to the gateway, whatever sits in front of it. An application
gets a **key** issued by the gateway itself, sent as `Authorization: Bearer
cap_…` — the header every OpenAI client already sends — and known by its own
name, the name every usage row records (§2a). It works wherever the gateway is
reachable: on a network of your own, behind a reverse proxy, through a tunnel.

An MCP client that cannot hold a key, such as Claude on the web, signs in with
OAuth instead: the gateway is its own authorization server, and signing in is
pasting one of its keys once on its page (`docs/deploy.md` §10.1). The tokens
it gets stand in for that key, under that key's name, on `/mcp` only.

**Behind Cloudflare Access**, which a host may keep as an extra layer
(`docs/deploy.md` §9.1), Access is the door and the key is still the name: an
application sends its key and a Cloudflare service token (§2b), the edge lets
it through on the token, and the gateway names it by the key. How each caller
is named then:

| Caller | Sends | Access | Name in the usage rows |
|---|---|---|---|
| An application | a service token and a key | lets it through | the key's name |
| The owner, in a browser | an Access login with their email | lets them through | the email, which can be in `server.access.admins` |
| Claude on the web | an OAuth token, on paths Access bypasses | not involved | the name of the key used to sign in |
| An application with no key yet | a service token only | lets it through | its client id, named by `server.access.callers` |

The last row is what the client-id map exists for; an application that sends
a key does not need it. Without Access, only the first and third rows remain,
without the service token.

## 1. Store nothing yet, decide the name

The application's name, lower case, digits and dashes: `app-one`. It is the
name `/v1/usage` reports, the name of the key or of the binding, and the name
in the Access policy. One name, everywhere.

## 2a. A key from the gateway

Anyone whose name is in `server.access.admins` on the host (`docs/deploy.md`
§7) asks the gateway:

```sh
curl -s https://api.example.com/v1/admin/keys \
  -H "Authorization: Bearer $CAPITOLINE_ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"name":"app-one"}'
# {"name":"app-one","key":"cap_…","created_at":…}
```

The key is in that answer and **nowhere else, ever**: the gateway keeps its
hash. Put it where it belongs (§3) before closing the terminal. An admin who
is a person behind Access sends the Access headers or cookie instead of the
bearer; the answer is the same.

On a host with no admin yet — a fresh install, no Cloudflare in front — the
first key is made on the host, as the service's user:

```sh
cd /var/lib/capitoline/app && sudo -u capitoline env CAPITOLINE_OVERLAY=/etc/capitoline/overlay.yaml npm run keys -- create app-one
```

Then put that name in `server.access.admins` if it is to manage the others.
Until the first key exists a gateway with no Access is open to whoever
reaches its port; the first key closes it, and the startup log says which
state it is in.

`GET /v1/admin/keys` lists the keys (names, dates, last use; never the
secret). Nothing needs restarting.

## 2b. Behind Cloudflare Access: a service token as well

Only on a host that keeps Access in front (`docs/deploy.md` §9.1): the token
gets the application past the edge, and the key of §2a still names it.
Scripted, from your own machine (never from the gateway host):

```sh
CF_API_TOKEN=… CF_ACCOUNT_ID=… CF_ACCESS_APP_ID=… \
CAPITOLINE_URL=https://api.example.com CAPITOLINE_ADMIN_KEY=cap_… \
scripts/cf-service-token.sh app-one
```

It creates the token (one year), gives the Capitoline application a Service
Auth policy named after the application holding that token alone, binds the
client id to the name in the gateway (`PUT /v1/admin/callers/<client id>`),
and prints the two headers once. `CF_API_TOKEN` is a Cloudflare API token
with **Access: Service Tokens Write** and **Access: Apps and Policies
Write**, made under My Profile → API Tokens; the application id is in the
Zero Trust dashboard under the application's settings.

By hand, the same three steps: Zero Trust → **Access** → **Service Auth** →
**Service Tokens** → **Create Service Token** (name, one year; the secret is
shown once); then a policy on the `capitoline` application, action Service
Auth, include that token — one policy per application, so the dashboard says
which applications exist; then the binding, either through the admin API as
above or as a line under `server.access.callers` in the host overlay
(`docs/deploy.md` §7), because Cloudflare's JWT carries the **client id** and
not the name, and without the binding `/v1/usage` calls the application
`<32 hex>.access`. The binding matters only for an application that sends no
key; one that sends its key is named by it.

Nothing in the gateway needs restarting for the token or the policy: Access
decides at the edge. The binding through the API needs no restart either.

## 3. Store the secret

Never in a repository, never in a `.env` that is committed, never echoed into
a terminal that is being recorded. Where it goes depends on where the
application runs:

- **A serverless function** (a Cloudflare Worker, for instance): the
  platform's own secret store — `npx wrangler secret put CAPITOLINE_API_KEY`
  from the Worker's own directory. A project with several Workers has several
  directories: check which one you are in before pressing enter.
- **A program run from a shell or a scheduler**: an environment variable set
  from a file outside the repository, kept with the application's other
  credentials and readable by its user alone.
- **A CI workflow**: the CI's secret store (`gh secret set CAPITOLINE_API_KEY`
  for GitHub Actions), from a real terminal.

For a service token, the same with its two values, `CAPITOLINE_CLIENT_ID` and
`CAPITOLINE_CLIENT_SECRET`.

## 4. Call it

Base URL `https://api.example.com/v1`. With a key:

```
Authorization: Bearer cap_…
```

With a service token, the two headers on every request:

```
CF-Access-Client-Id: <client id>
CF-Access-Client-Secret: <client secret>
```

The credential works:

```sh
curl -s https://api.example.com/v1/models \
  -H "Authorization: Bearer $CAPITOLINE_API_KEY" | jq '.data[].id'
```

Without it, the same call is refused — at the edge for a gateway behind
Access (`302` or `401`, an HTML body), by the gateway itself otherwise (`401`,
a JSON error):

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://api.example.com/v1/models
# 302 or 401 — not 200
```

Run both before telling an application to use the credential. The second is
the one people skip, and it is the one that proves the door is doing anything.

**From an OpenAI SDK**: set the base URL to `/v1` and the key as the API key;
that is all. For a service token, any placeholder as the API key and the two
headers as default headers:

```js
new OpenAI({ baseURL: "https://api.example.com/v1", apiKey: env.CAPITOLINE_API_KEY });

new OpenAI({
  baseURL: "https://api.example.com/v1",
  apiKey: "unused",
  defaultHeaders: {
    "CF-Access-Client-Id": env.CAPITOLINE_CLIENT_ID,
    "CF-Access-Client-Secret": env.CAPITOLINE_CLIENT_SECRET,
  },
});
```

**What the gateway answers with.** `200` with an OpenAI-shaped body, plus an
extra `capitoline` field an OpenAI client ignores. `429` with `Retry-After`
when a subscription's window is exhausted — wait it out, do not retry in a
loop, and a multi-day figure means that model is gone until it says otherwise.
`503` with a short `Retry-After` when a provider's own servers are full, which
clears by itself. `404` for a model that is currently unavailable or retired,
which is why `/v1/models` is worth reading rather than hard-coding a name.
`401` for a credential the gateway does not know or has revoked.

**A council, quick or full.** `model: capitoline` is the full council, nine
calls and minutes; the same request with `reasoning_effort: low` skips the
peer-ranking stage and costs five. A client that cannot set the field asks for
`capitoline-fast`, which is the same thing under its own name. Either way the
response's `capitoline.council.shape` says which one ran, and either way ask
for `stream: true` through a tunnel (`docs/deploy.md` §9).

## 5. What a credential may be used for

The four conditions of `docs/terms-of-service.md`, restated so a reader can
check their own path against them. **All four must hold**, on every path that
reaches a subscription model:

1. No text another person wrote reaches a prompt.
2. Personal volume.
3. Nothing is sold.
4. No provider is named or branded in the output.

**Content you generate and then publish.** A site whose pages are written and
reviewed through the gateway, then published: condition 1 is not even in
question, since no reader of the site is involved in producing the text.
Within the rule.

**A bot whose commands assemble the prompt from fixed data.** A person presses
a command, and the application builds the prompt from data it owns — a menu,
a date, a closed list of options — and never from anything the person typed.
Within the rule, as long as it stays that way.

**What would break it.** A free-text field, a question box, a command that
forwards its argument: any path where a person's own words reach the prompt.
Any of those makes condition 1 false, and that path goes to inference the
person's words may reach — a free tier, or models you host yourself. It is not
a matter of volume and a rate limit does not buy it.

If you are unsure which side a new path falls on, the test is short: **can a
person put words of their own in front of the model?** If yes, not this
credential.

## 6. Revoking

**A key:** `DELETE /v1/admin/keys/<name>` as an admin, or on the host
`npm run keys -- revoke <name>`. At once; the key stays listed as revoked so
the usage rows written under its name keep it, and the application gets `401`
with a JSON error from the gateway.

**A service token:** Zero Trust → Access → Service Auth → Service Tokens →
delete it (or the API, `DELETE …/access/service_tokens/<id>`). It takes
effect at once, at the edge: the application then gets `302` or `401` from
Access, with an HTML body, not a JSON error from the gateway — the request
never reaches it. An application that reports "the gateway is down" after a
revocation is reporting the revocation. Worth knowing before debugging the
wrong machine. The policy named after the application can go with it.

Rotating is the same procedure run forwards: create the new credential,
update the secret, verify with the two `curl` calls above, then revoke the old
one. In that order, so nothing is down in between.
