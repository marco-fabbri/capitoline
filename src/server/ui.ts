import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The operator's page (/ui): three static files, served as they are.
 *
 * The files hold no data and no secret, so they are served without a
 * credential, like the OAuth sign-in page: everything the page shows it asks
 * of the API, with a key the operator pastes and the browser keeps for that tab
 * alone. The page is therefore exactly as privileged as its key, and adds no
 * second source of truth: what it does, curl can do.
 *
 * No framework and no build: one HTML file, one script, one stylesheet, read
 * once at startup from `ui/` at the root of the repository. The policy below
 * lets the page load only those and talk only to its own origin, and forbids
 * any other page from framing it.
 */
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

export function createUiRouter(dir = fileURLToPath(new URL("../../ui/", import.meta.url))): express.Router {
  const router = express.Router();
  const loaded = Object.fromEntries(Object.entries(FILES).map(([path, f]) => [path, { type: f.type, body: readFileSync(`${dir}/${f.file}`) }]));
  router.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-cache");
    next();
  });
  for (const [path, f] of Object.entries(loaded)) {
    router.get(path, (_req, res) => { res.type(f.type).send(f.body); });
  }
  return router;
}
