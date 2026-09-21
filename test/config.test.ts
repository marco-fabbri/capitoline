import { describe, it, expect } from "vitest";
import { loadConfig, parseConfig } from "../src/config.js";

describe("config", () => {
  it("loads the repository config", () => {
    const cfg = loadConfig("config/capitoline.yaml");
    expect(Object.keys(cfg.providers).sort()).toEqual(["antigravity", "claude", "codex"]);
    expect(cfg.providers.claude.models["claude-opus"].cli_model).toBe("opus");
    expect(cfg.providers.antigravity.models["agy-gemini-flash"].effort_suffix).toBe(true);
    expect(cfg.server.port).toBe(8080);
    expect(cfg.usage.db_path).toBe("capitoline.sqlite");
  });
  it("loads the repository config with the agy-image model and the collect helper", () => {
    const cfg = loadConfig("config/capitoline.yaml");
    const agy = cfg.providers.antigravity;
    expect(agy.models["agy-image"]).toEqual({ cli_model: "gemini-3.8-flash-low", effort_suffix: false, kind: "image", timeout_s: 240 });
    expect(agy.models["agy-gemini-3.7-flash"].cli_model).toBe("gemini-3.7-flash");
    expect(agy.models["agy-gemini-3.6-flash"].cli_model).toBe("gemini-3.6-flash");
    expect(agy.image.collect).toEqual(["/usr/local/bin/capitoline-collect-image"]);
    expect(agy.image.min_bytes).toBe(200000);
    expect(agy.image.quota_per_window).toBe(12);
    expect(agy.image.allowed_tools).toEqual(["generate_image"]);
    expect(agy.image.args).toEqual([]);
    expect(cfg.providers.claude.image).toEqual({ args: [], allowed_tools: ["generate_image"], collect: undefined, min_bytes: 200000 });
  });
  it("defaults a model's kind to text with no per-model timeout", () => {
    const text = `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: a, models: { a: {cli_model: a} }, effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin }
runner: { sandbox_root: /tmp/x }
`;
    const m = parseConfig(text).providers.x.models.a;
    expect(m.kind).toBe("text");
    expect(m.timeout_s).toBeUndefined();
  });
  it("accepts an image model with its own timeout when the provider can collect images", () => {
    const text = `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: a, models: { a: {cli_model: a}, img: {cli_model: i, kind: image, timeout_s: 240} },
       effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin,
       image: { collect: [/usr/local/bin/collect, --flag], min_bytes: 10, args: [--x], allowed_tools: [generate_image, other] } }
runner: { sandbox_root: /tmp/x }
`;
    const p = parseConfig(text).providers.x;
    expect(p.models.img).toEqual({ cli_model: "i", effort_suffix: false, kind: "image", timeout_s: 240 });
    expect(p.models.a.kind).toBe("text");
    expect(p.image).toEqual({ collect: ["/usr/local/bin/collect", "--flag"], min_bytes: 10, args: ["--x"], allowed_tools: ["generate_image", "other"] });
  });
  it("rejects an unknown model kind and a non-positive timeout", () => {
    const base = (models: string) => `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: a, models: { ${models} }, effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin,
       image: { collect: [c] } }
runner: { sandbox_root: /tmp/x }
`;
    expect(() => parseConfig(base("a: {cli_model: a, kind: video}"))).toThrow(/models\.a\.kind/);
    expect(() => parseConfig(base("a: {cli_model: a, timeout_s: 0}"))).toThrow(/models\.a\.timeout_s/);
  });
  it("rejects a health_model that is an image model", () => {
    const text = `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: img, models: { a: {cli_model: a}, img: {cli_model: i, kind: image} },
       effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin, image: { collect: [c] } }
runner: { sandbox_root: /tmp/x }
`;
    expect(() => parseConfig(text)).toThrow(/health_model "img" must be a text model/);
  });
  it("rejects an image model when the provider has no image.collect command", () => {
    const text = `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: a, models: { a: {cli_model: a}, img: {cli_model: i, kind: image} },
       effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin }
runner: { sandbox_root: /tmp/x }
`;
    expect(() => parseConfig(text)).toThrow(/providers\.x\.image\.collect: .*image models.*image\.collect/);
    expect(() => parseConfig(text.replace("prompt_via: stdin }", "prompt_via: stdin, image: { collect: [] } }"))).toThrow(/image\.collect/);
  });
  it("rejects a health_model that is not one of the provider's models", () => {
    const text = `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: nope, models: { a: {cli_model: a} }, effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin }
runner: { sandbox_root: /tmp/x }
`;
    expect(() => parseConfig(text)).toThrow(/health_model/);
  });
  it("rejects the same public model name in two providers", () => {
    const text = `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: a, models: { a: {cli_model: a} }, effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin }
  y: { binary: y, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: a, models: { a: {cli_model: a} }, effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin }
runner: { sandbox_root: /tmp/x }
`;
    expect(() => parseConfig(text)).toThrow(/duplicate model name "a"/);
  });
  it("rejects reserved council names", () => {
    const text = `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: capitoline, models: { capitoline: {cli_model: a} }, effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin }
runner: { sandbox_root: /tmp/x }
`;
    expect(() => parseConfig(text)).toThrow(/reserved/);
  });
  it("rejects server.access with only one of team_domain and audience", () => {
    const provider = `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: a, models: { a: {cli_model: a} }, effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin }
runner: { sandbox_root: /tmp/x }
`;
    expect(() => parseConfig(`server: { access: { team_domain: t.cloudflareaccess.com } }\n${provider}`)).toThrow(/server\.access\.audience/);
    expect(() => parseConfig(`server: { access: { audience: abc } }\n${provider}`)).toThrow(/server\.access\.team_domain/);
    expect(parseConfig(`server: { access: { team_domain: t.cloudflareaccess.com, audience: abc } }\n${provider}`).server.access.audience).toBe("abc");
    expect(parseConfig(provider).server.access).toEqual({ team_domain: "", audience: "" });
  });

  it("rejects an unknown key in any of the objects", () => {
    const base = `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: a, models: { a: {cli_model: a} }, effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin }
runner: { sandbox_root: /tmp/x }
`;
    // The one with teeth: `usr` for `user` used to be dropped silently, which
    // runs the CLIs as the gateway's own user with no privilege separation.
    expect(() => parseConfig(base.replace("runner: { sandbox_root: /tmp/x }", "runner: { sandbox_root: /tmp/x, usr: runner }")))
      .toThrow(/runner: Unrecognized key\(s\) in object: 'usr'/);
    // A wrong value, not a wrong key: `.strict()` cannot see it, and an empty
    // user takes the same no-sudo branch as null, silently.
    expect(() => parseConfig(base.replace("runner: { sandbox_root: /tmp/x }", 'runner: { sandbox_root: /tmp/x, user: "" }')))
      .toThrow(/runner\.user/);
    expect(() => parseConfig(base.replace("{cli_model: a}", "{cli_model: a, effort_sufix: true}")))
      .toThrow(/providers\.x\.models\.a: Unrecognized key\(s\) in object: 'effort_sufix'/);
    expect(() => parseConfig(base.replace("binary: x,", "binary: x, timeouts_s: 1,")))
      .toThrow(/providers\.x: Unrecognized key\(s\) in object: 'timeouts_s'/);
    expect(() => parseConfig(base.replace("window_7d_tokens: 0}", "window_7d_tokens: 0, window_30d_tokens: 0}")))
      .toThrow(/providers\.x\.budget: Unrecognized key\(s\) in object: 'window_30d_tokens'/);
    expect(() => parseConfig(base.replace("prompt_via: stdin }", "prompt_via: stdin, image: { collect: [c], min_byte: 1 } }")))
      .toThrow(/providers\.x\.image: Unrecognized key\(s\) in object: 'min_byte'/);
    expect(() => parseConfig(`server: { prt: 9 }\n${base}`)).toThrow(/server: Unrecognized key\(s\) in object: 'prt'/);
    expect(() => parseConfig(`server: { access: { team_domain: t, audience: a, extra: 1 } }\n${base}`))
      .toThrow(/server\.access: Unrecognized key\(s\) in object: 'extra'/);
    expect(() => parseConfig(`server: { queue: { max_wait_s: 1, min_wait_s: 1 } }\n${base}`))
      .toThrow(/server\.queue: Unrecognized key\(s\) in object: 'min_wait_s'/);
    expect(() => parseConfig(`usage: { db_path: x, dbpath: y }\n${base}`))
      .toThrow(/usage: Unrecognized key\(s\) in object: 'dbpath'/);
    expect(() => parseConfig(`usag: {}\n${base}`)).toThrow(/: Unrecognized key\(s\) in object: 'usag'/);
  });
  it("rejects a health_model that is only an Object.prototype key", () => {
    const text = `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: toString, models: { a: {cli_model: a} }, effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin }
runner: { sandbox_root: /tmp/x }
`;
    expect(() => parseConfig(text)).toThrow(/health_model "toString" is not one of provider x's models/);
  });
  it("rejects an empty providers map", () => {
    expect(() => parseConfig(`providers: {}\nrunner: { sandbox_root: /tmp/x }\n`)).toThrow(/providers: .*at least one provider/);
  });
  it("rejects a model effort the provider's effort table does not define", () => {
    const text = `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: a, models: { a: {cli_model: a, efforts: [low, high]} }, effort: { low: low },
       args: [], system_prompt_flag: null, prompt_via: stdin }
runner: { sandbox_root: /tmp/x }
`;
    expect(() => parseConfig(text)).toThrow(/providers\.x\.models\.a\.efforts: .*"high".*effort table/);
    expect(() => parseConfig(text.replace("effort: { low: low }", "effort: { low: low, high: high }"))).not.toThrow();
    // An empty value is the same silent drop one level down: `--effort ""`.
    expect(() => parseConfig(text.replace("effort: { low: low }", 'effort: { low: "", high: high }')))
      .toThrow(/providers\.x\.effort\.low/);
  });
  it("rejects a model that needs an effort value against an empty effort table", () => {
    const text = (model: string) => `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: a, models: { a: ${model} }, effort: {},
       args: [], system_prompt_flag: null, prompt_via: stdin }
runner: { sandbox_root: /tmp/x }
`;
    // effort_suffix with nothing to append leaves the CLI with a base model id
    // that, for Antigravity, is not a model id at all.
    expect(() => parseConfig(text("{cli_model: a, effort_suffix: true}")))
      .toThrow(/providers\.x\.effort: .*"a" needs an effort value.*effort table is empty/);
    expect(() => parseConfig(text("{cli_model: a, efforts: [low]}")))
      .toThrow(/effort table is empty/);
    expect(() => parseConfig(text("{cli_model: a}"))).not.toThrow();
  });
  it("rejects every reserved capitoline* model name", () => {
    const text = (name: string) => `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: ${name}, models: { ${name}: {cli_model: a} }, effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin }
runner: { sandbox_root: /tmp/x }
`;
    expect(() => parseConfig(text("capitolineX"))).toThrow(/reserved/);
    expect(() => parseConfig(text("capitoline-council"))).toThrow(/reserved/);
    expect(() => parseConfig(text("capitol"))).not.toThrow();
  });
});
