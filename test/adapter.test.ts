import { describe, it, expect } from "vitest";
import { loadConfig, type ProviderConfig } from "../src/config.js";
import { effortValue, type ModelSpec } from "../src/providers/adapter.js";

const base = loadConfig("config/capitoline.yaml").providers.claude;
// The cast is the point of these cases: a table missing a level is what the
// schema cannot forbid once the file is hand-edited on the host.
const withEffort = (effort: Partial<ProviderConfig["effort"]>): ProviderConfig => ({ ...base, effort: effort as ProviderConfig["effort"] });
const model = (efforts?: ModelSpec["efforts"]): ModelSpec =>
  ({ name: "m", provider: "p", cliModel: "m", effortSuffix: false, kind: "text", efforts });

describe("effortValue", () => {
  it("returns the requested level when the model and the table both have it", () => {
    expect(effortValue(base, model(["low", "high"]), "low")).toEqual({ effort: "low", value: "low" });
  });
  it("defaults to medium when the request asks for no effort", () => {
    expect(effortValue(base, model(), undefined)).toEqual({ effort: "medium", value: "medium" });
  });
  it("falls back to a level the provider's table defines when the model offers one it does not", () => {
    // The mismatch the configuration cannot catch: a model declaring an effort
    // the provider's table no longer prices. Picking the nearest level first
    // landed on "high", found no value for it and dropped the effort entirely.
    const cfg = withEffort({ low: "L" });
    expect(effortValue(cfg, model(["low", "high"]), "high")).toEqual({ effort: "low", value: "L" });
  });
  it("returns null when the model offers no level the table defines", () => {
    const cfg = withEffort({ medium: "M" });
    expect(effortValue(cfg, model(["low", "high"]), "high")).toBeNull();
  });
  it("returns null when the provider declares no effort table", () => {
    expect(effortValue(withEffort({}), model(["low"]), "low")).toBeNull();
  });
  it("resolves a level the model does not offer to the higher neighbour", () => {
    // The tie-break is deliberate and pinned here: "medium" on a low/high
    // model runs high. See the note above effortValue for why.
    expect(effortValue(base, model(["low", "high"]), "medium")).toEqual({ effort: "high", value: "high" });
    const cfg = withEffort({ low: "L", high: "H" });
    expect(effortValue(cfg, model(), "medium")).toEqual({ effort: "high", value: "H" });
  });
});
