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
});
