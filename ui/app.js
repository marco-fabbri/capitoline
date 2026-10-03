// The operator's page. It holds no data of its own: every view is a call to the
// gateway's API with the key pasted at sign-in, which lives in sessionStorage
// (this tab only). Text reaches the page through textContent, never as markup.
"use strict";

const STORE = "capitoline.key";
const $ = (id) => document.getElementById(id);
let key = null;
try { key = sessionStorage.getItem(STORE); } catch { /* a browser without storage still signs in, for this page load */ }
let tab = "overview";
let usageDays = 7;

// ---- small helpers -------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
}
const chip = (text, kind = "") => el("span", { class: `chip ${kind}` }, text);
const num = (n) => Number(n ?? 0).toLocaleString();
const when = (ms) => (ms ? new Date(ms).toLocaleString() : "—");
function until(ms) {
  const left = ms - Date.now();
  if (left <= 0) return "now";
  const m = Math.round(left / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d > 0 ? `in ${d}d ${h % 24}h` : h > 0 ? `in ${h}h ${m % 60}m` : `in ${m}m`;
}
function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").className = error ? "error" : "";
}
function table(headers, rows, empty = "Nothing here.") {
  if (rows.length === 0) return el("div", { class: "scroll" }, el("div", { class: "empty" }, empty));
  const numeric = headers.map((h) => h.startsWith("#"));
  return el("div", { class: "scroll" }, el("table", {},
    el("thead", {}, el("tr", {}, headers.map((h, i) => el("th", { class: numeric[i] ? "num" : "" }, h.replace(/^#/, ""))))),
    el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c, i) => el("td", { class: numeric[i] ? "num" : "" }, c)))))));
}
// A destructive action asks twice without a dialog: the first click arms the
// button for a few seconds, the second one acts.
function confirmButton(label, action, cls = "danger") {
  const b = el("button", { type: "button", class: cls }, label);
  let armed = null;
  b.addEventListener("click", async () => {
    if (!armed) {
      b.textContent = "Confirm?"; b.classList.add("confirming");
      armed = setTimeout(() => { armed = null; b.textContent = label; b.classList.remove("confirming"); }, 4000);
      return;
    }
    clearTimeout(armed); armed = null; b.disabled = true;
    await run(action);
  });
  return b;
}
// Runs an action, says what happened, and redraws the current view.
async function run(action, done) {
  try {
    const said = await action();
    notice(said ?? done ?? "Done.");
  } catch (e) { notice(e.message, true); }
  await show();
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method, cache: "no-store",
    headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { signOut("That key is no longer accepted."); throw new Error("signed out"); }
  if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
  return data;
}

// ---- sign in and out -----------------------------------------------------

function signOut(message = "") {
  key = null;
  try { sessionStorage.removeItem(STORE); } catch { /* nothing was kept */ }
  $("app").hidden = true; $("signin").hidden = false;
  $("signin-error").textContent = message;
  $("key").value = ""; $("key").focus();
}
async function signIn(candidate) {
  const res = await fetch("/v1/admin/whoami", { cache: "no-store", headers: { authorization: `Bearer ${candidate}` } });
  if (res.status === 401) throw new Error("That is not a valid key.");
  if (res.status === 403) throw new Error("That key is valid, but it is not an administrator's (server.access.admins).");
  if (res.status === 404) throw new Error("This gateway has no administrators configured (server.access.admins).");
  if (!res.ok) throw new Error(`The gateway answered HTTP ${res.status}.`);
  const who = await res.json();
  key = candidate;
  try { sessionStorage.setItem(STORE, key); } catch { /* signed in for this page load only */ }
  $("who").textContent = who.admin;
  $("signin").hidden = true; $("app").hidden = false;
  await show();
}

// ---- views ---------------------------------------------------------------

const VIEWS = {
  overview: ["Overview", async () => {
    const [health, pauses] = await Promise.all([api("/health"), api("/v1/admin/pauses")]);
    const cards = health.providers.map((p) => {
      const h = p.health, v = p.version;
      return el("div", { class: "card" },
        el("h3", {}, p.id, !h ? chip("not checked yet") : h.ok ? chip("healthy", "ok") : chip(h.kind ?? "unhealthy", "bad"),
          p.pausedUntil && p.pausedUntil > Date.now() ? chip(`paused, back ${until(p.pausedUntil)}`, "warn") : null,
          p.overBudget ? chip("over budget", "warn") : null),
        el("dl", {},
          el("dt", {}, "CLI"), el("dd", {}, v ? `${v.installed ?? "?"}` : "—", v?.updateAvailable ? [" ", chip(`${v.latest} available`, "warn")] : null),
          el("dt", {}, "Checked"), el("dd", {}, h ? when(h.checkedAt) : "—"),
          h && !h.ok && h.detail ? [el("dt", {}, "Detail"), el("dd", {}, h.detail)] : null,
          el("dt", {}, "Running"), el("dd", {}, `${p.active} active, ${p.waiting} waiting`),
          p.catalog ? [el("dt", {}, "Catalog"), el("dd", {}, p.catalog.checkedAt ? `read ${when(p.catalog.checkedAt)}` : "not read yet",
            p.catalog.discovered.length ? `, ${p.catalog.discovered.length} discovered` : "", p.catalog.retired.length ? `, ${p.catalog.retired.length} retired` : "")] : null),
        el("button", { type: "button", on: { click: () => run(async () => { notice(`Checking ${p.id}… this is a real call and can take a minute.`); await api("/v1/admin/health-check", { method: "POST", body: { provider: p.id } }); return `${p.id} checked.`; }) } }, "Check now"));
    });
    const rows = pauses.pauses.map((p) => [
      p.provider, p.scope ?? "the whole provider", el("span", { class: "wrap" }, p.models.join(", ")),
      `${when(p.until)} (${until(p.until)})`, p.strikes,
      confirmButton("Lift", async () => { await api(`/v1/admin/pauses/${encodeURIComponent(p.provider)}${p.scope ? `?scope=${encodeURIComponent(p.scope)}` : ""}`, { method: "DELETE" }); return "Pause lifted."; }),
    ]);
    return [
      el("div", { class: "cards" }, cards),
      el("div", { class: "row" },
        el("button", { type: "button", on: { click: () => run(async () => { notice("Reading the catalogs…"); await api("/v1/admin/catalog-check", { method: "POST" }); return "Catalogs read."; }) } }, "Read model catalogs now"),
        el("button", { type: "button", on: { click: () => run(async () => { const r = await api("/v1/admin/notify-test", { method: "POST" }); return r.delivered ? "Test notification delivered." : "The notification was not delivered: see the journal."; }) } }, "Send a test notification")),
      el("h2", {}, "Pauses"),
      table(["Provider", "Scope", "Holds back", "Until", "#Strikes", ""], rows, "Nothing is paused."),
    ];
  }],

  models: ["Models", async () => {
    const health = await api("/health");
    const minutes = el("select", { "aria-label": "For how long" },
      [[30, "30 minutes"], [120, "2 hours"], [720, "12 hours"], [1440, "1 day"], [10080, "7 days"]].map(([v, t]) => el("option", { value: v }, t)));
    const rows = health.models.map((m) => [
      el("span", { class: "mono" }, m.name), m.provider, m.kind,
      m.available ? chip("available", "ok") : chip(m.reason ?? "unavailable", m.reason === "retired" ? "" : "bad"),
      m.quota ? `${m.quota.used}${m.quota.limit ? ` / ${m.quota.limit}` : ""}${m.quota.resetAt ? `, back ${until(m.quota.resetAt)}` : ""}` : "",
      m.kind === "council" || !m.available ? "" : confirmButton("Hold back", async () => {
        await api("/v1/admin/pauses", { method: "POST", body: { provider: m.provider, model: m.name, minutes: Number(minutes.value) } });
        return `${m.name} is held back. Lift it from Overview.`;
      }, ""),
    ]);
    return [
      el("div", { class: "row" }, el("label", {}, "Hold a model back for ", minutes), el("span", { class: "chip" }, "a pause like any other: it ends by itself, or you lift it")),
      table(["Model", "Provider", "Kind", "State", "Image quota", ""], rows),
    ];
  }],

  usage: ["Usage", async () => {
    const days = usageDays;
    const [daily, day] = await Promise.all([api(`/v1/admin/usage?days=${days}`), api("/v1/usage")]);
    const sum = (rows, keyOf) => {
      const out = new Map();
      for (const r of rows) {
        const k = keyOf(r), a = out.get(k) ?? { calls: 0, ok: 0, i: 0, o: 0 };
        a.calls += r.calls; a.ok += r.outcome === "ok" ? r.calls : 0; a.i += r.inputTokens; a.o += r.outputTokens;
        out.set(k, a);
      }
      return [...out].sort((a, b) => b[1].calls - a[1].calls).map(([k, a]) => [k, num(a.calls), num(a.calls - a.ok), num(a.i), num(a.o)]);
    };
    const range = el("select", { "aria-label": "Range", on: { change: (e) => { usageDays = Number(e.target.value); show(); } } },
      [1, 7, 30, 90].map((d) => el("option", { value: d, selected: d === days }, d === 1 ? "last day" : `last ${d} days`)));
    const byDay = [...daily.rows.reduce((m, r) => m.set(r.day, [...(m.get(r.day) ?? []), r]), new Map())]
      .map(([d, rows]) => [d, num(rows.reduce((s, r) => s + r.calls, 0)), num(rows.filter((r) => r.outcome !== "ok").reduce((s, r) => s + r.calls, 0)),
        num(rows.reduce((s, r) => s + r.inputTokens, 0)), num(rows.reduce((s, r) => s + r.outputTokens, 0))]);
    return [
      el("div", { class: "row" }, el("label", {}, "Show the ", range)),
      el("h2", {}, "By caller"), table(["Caller", "#Calls", "#Not ok", "#Input tokens", "#Output tokens"], sum(daily.rows, (r) => r.caller ?? "(not identified)"), "No calls in this range."),
      el("h2", {}, "By model"), table(["Model", "#Calls", "#Not ok", "#Input tokens", "#Output tokens"], sum(daily.rows, (r) => r.model), "No calls in this range."),
      el("h2", {}, "By day (UTC)"), table(["Day", "#Calls", "#Not ok", "#Input tokens", "#Output tokens"], byDay, "No calls in this range."),
      el("h2", {}, "What actually answered, last 7 days"),
      table(["Name asked for", "Model that answered", "#Calls", "First", "Last"], day.models.map((m) => [m.model, m.cliModelId, num(m.calls), when(m.firstAt), when(m.lastAt)]), "No CLI reported a model id."),
      el("p", {}, "Token counts follow each provider's own convention, so they compare within a provider and not across."),
    ];
  }],

  keys: ["Keys", async () => {
    const name = el("input", { placeholder: "name, e.g. app-one", "aria-label": "Name of the new key", spellcheck: "false" });
    const shown = el("div"), list = el("div");
    // The list is redrawn by itself, so a key just created stays on screen
    // above it: that is the only time the key is shown.
    const drawList = async () => {
      const { keys } = await api("/v1/admin/keys");
      list.replaceChildren(table(["Name", "Created", "By", "Last used", "State", ""], keys.map((k) => [
        el("span", { class: "mono" }, k.name), when(k.created_at), k.created_by ?? "", k.last_used_at ? when(k.last_used_at) : "never",
        k.revoked_at ? chip(`revoked ${when(k.revoked_at)}`) : chip("live", "ok"),
        k.revoked_at ? "" : confirmButton("Revoke", async () => { await api(`/v1/admin/keys/${encodeURIComponent(k.name)}`, { method: "DELETE" }); return `Key "${k.name}" revoked, with every OAuth token it stood behind.`; }),
      ]), "No keys yet."));
    };
    const create = el("button", { type: "button", class: "primary", on: { click: async () => {
      try {
        const made = await api("/v1/admin/keys", { method: "POST", body: { name: name.value.trim() } });
        shown.replaceChildren(el("p", {}, `Key "${made.name}" created. This is the only time it is shown: copy it now.`), el("code", { class: "secret" }, made.key));
        name.value = ""; notice("Key created.");
        await drawList();
      } catch (e) { notice(e.message, true); }
    } } }, "Create key");
    await drawList();
    return [el("div", { class: "row" }, name, create), shown, list];
  }],

  callers: ["Callers", async () => {
    const { callers } = await api("/v1/admin/callers");
    const id = el("input", { placeholder: "caller id", "aria-label": "Caller id", spellcheck: "false" });
    const name = el("input", { placeholder: "name to show", "aria-label": "Name to show", spellcheck: "false" });
    const save = el("button", { type: "button", class: "primary", on: { click: () => run(async () => {
      await api(`/v1/admin/callers/${encodeURIComponent(id.value.trim())}`, { method: "PUT", body: { name: name.value } });
      return "Caller named.";
    }) } }, "Name caller");
    return [
      el("p", {}, "A name for a caller that reaches the gateway under an id (a Cloudflare service token's client id). Keys are already called by their own name."),
      el("div", { class: "row" }, id, name, save),
      table(["Id", "Shown as"], Object.entries(callers).map(([k, v]) => [el("span", { class: "mono" }, k), v]), "No caller has been named."),
    ];
  }],

  conversations: ["Conversations", async () => {
    const { owners } = await api("/v1/admin/conversations");
    const rows = owners.map((o) => [
      o.name || "(not identified)", num(o.threads), num(o.turns), `${num(Math.round(o.bytes / 1024))} KB`, when(o.lastUsedAt),
      confirmButton("Delete all", async () => { const r = await api(`/v1/admin/conversations/${encodeURIComponent(o.owner)}`, { method: "DELETE" }); return `${r.deleted} conversation(s) deleted.`; }),
    ]);
    return [
      el("p", {}, "What each caller has asked the gateway to keep (the Responses API, ask_model's conversation). Counts and sizes only: the text is the caller's, and is never shown here."),
      table(["Caller", "#Conversations", "#Turns", "#Size", "Last used", ""], rows, "No conversation is kept."),
    ];
  }],

  deliberations: ["Deliberations", async () => {
    const { deliberations } = await api("/v1/admin/deliberations?limit=30");
    const detail = el("div");
    const rows = deliberations.map((d) => [
      when(d.startedAt), d.caller ?? "", `${d.ok} / ${d.calls}`, `${Math.round((d.endedAt - d.startedAt) / 1000)} s`, num(d.inputTokens), num(d.outputTokens),
      el("button", { type: "button", on: { click: async () => {
        try {
          const one = await api(`/v1/admin/deliberations/${encodeURIComponent(d.id)}`);
          detail.replaceChildren(el("h2", {}, `Calls of ${d.id}`), table(["Time", "Provider", "Model", "Answered", "Outcome", "#Seconds", "#Input", "#Output"],
            one.calls.map((c) => [new Date(c.ts).toLocaleTimeString(), c.provider, c.model, c.cliModelId ?? "", c.outcome === "ok" ? chip("ok", "ok") : chip(c.outcome, "bad"), (c.durationMs / 1000).toFixed(1), num(c.inputTokens), num(c.outputTokens)])));
          detail.scrollIntoView({ block: "nearest" });
        } catch (e) { notice(e.message, true); }
      } } }, "Calls"),
    ]);
    return [table(["Started", "Caller", "Calls ok", "Span", "#Input tokens", "#Output tokens", ""], rows, "No council has deliberated yet."), detail];
  }],

  config: ["Configuration", async () => {
    const cfg = await api("/v1/admin/config");
    return [
      el("p", {}, "The configuration in force, read-only: the base file merged with the host's overlay. It is changed in those files, never from here."),
      el("pre", {}, JSON.stringify(cfg, null, 2)),
    ];
  }],
};

async function show() {
  $("tabs").replaceChildren(...Object.entries(VIEWS).map(([id, [label]]) =>
    el("button", { type: "button", "aria-current": id === tab ? "page" : null, on: { click: () => { tab = id; notice(""); show(); } } }, label)));
  try {
    $("view").replaceChildren(...(await VIEWS[tab][1]()).flat().filter(Boolean));
  } catch (e) {
    if (e.message !== "signed out") { $("view").replaceChildren(); notice(e.message, true); }
  }
}

// ---- start ---------------------------------------------------------------

$("signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("signin-error").textContent = "";
  try { await signIn($("key").value.trim()); } catch (err) { $("signin-error").textContent = err.message; }
});
$("signout").addEventListener("click", () => signOut());
$("refresh").addEventListener("click", () => { notice(""); show(); });

if (key) signIn(key).catch(() => signOut());
else signOut();
