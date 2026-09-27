// The gateway's keys from the command line, for the install that has no
// administrator yet: with no Cloudflare Access in front there is no identity
// to put in server.access.admins until a key exists, and this is how the
// first one is made (docs/deploy.md §8). It opens the database the
// configuration names, so it runs where the service runs and as the user
// that owns the file.
//
//   npm run keys -- create <name>     prints the key, once
//   npm run keys -- list
//   npm run keys -- revoke <name>
import { loadConfig } from "./config.js";
import { UsageStore } from "./usage/store.js";

function usage(): never {
  console.error("usage: npm run keys -- create <name> | list | revoke <name>");
  process.exit(2);
}

const [command, name] = process.argv.slice(2);
const cfg = loadConfig(process.env.CAPITOLINE_CONFIG ?? "config/capitoline.yaml", process.env.CAPITOLINE_OVERLAY || undefined);
const store = new UsageStore(cfg.usage.db_path);
try {
  if (command === "create" && name) {
    const created = store.createKey(name, "cli");
    // The key and nothing else on stdout, so `npm run keys -- create x > file`
    // captures exactly it; the reminder goes to stderr.
    console.log(created.key);
    console.error(`key "${name}" created; this is the only time it is shown`);
  } else if (command === "list" && !name) {
    for (const k of store.listKeys()) {
      const state = k.revokedAt !== null ? `revoked ${new Date(k.revokedAt).toISOString()}` : k.lastUsedAt !== null ? `last used ${new Date(k.lastUsedAt).toISOString()}` : "never used";
      console.log(`${k.name}\t${new Date(k.createdAt).toISOString()}\t${k.createdBy ?? "-"}\t${state}`);
    }
  } else if (command === "revoke" && name) {
    if (!store.revokeKey(name)) { console.error(`no live key named "${name}"`); process.exit(1); }
    console.error(`key "${name}" revoked`);
  } else {
    usage();
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
} finally {
  store.close();
}
