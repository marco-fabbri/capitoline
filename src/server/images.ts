import { z } from "zod";
import { CapitolineError, type ImageRequest, type ProviderEvent } from "../core/types.js";

// OpenAI's images API, restricted to what the CLI tool can honour: one prompt,
// one image, returned inline. Size has no counterpart (the tool has no size
// parameter), so it is accepted and reported as ignored, like quality and style.
const Body = z.object({
  prompt: z.string().min(1, "prompt must not be empty"),
  model: z.string().min(1).optional(),
}).passthrough();

// Same policy as the chat route: fields the gateway honours, fields it cannot
// provide (400 when actually requested), everything else dropped and listed in
// X-Capitoline-Ignored (spec 6.1), unknown keys included.
const HONORED = new Set(["prompt", "model", "n", "response_format", "output_format"]);

export interface ConvertedImage { req: ImageRequest; ignored: string[] }
export type ImageEvent = Extract<ProviderEvent, { type: "image" }>;

export function convertImageRequest(body: unknown, defaultModel: string | undefined): ConvertedImage {
  const parsed = Body.safeParse(body);
  if (!parsed.success) throw new CapitolineError("bad_request", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  const b = parsed.data as Record<string, unknown> & z.infer<typeof Body>;
  if ("n" in b && b.n !== undefined && b.n !== null && b.n !== 1) throw new CapitolineError("bad_request", `"n" must be 1`);
  const fmt = b.response_format;
  if (fmt !== undefined && fmt !== null && fmt !== "b64_json") throw new CapitolineError("bad_request", `"response_format" must be "b64_json": this gateway returns the image inline`);
  // output_format asks for a file format, not a style: the gateway hands back
  // whatever the CLI produced (JPEG), so anything else is refused, not ignored.
  const out = b.output_format;
  if (out !== undefined && out !== null && out !== "jpeg") throw new CapitolineError("bad_request", `"output_format" is not supported: this gateway returns the image in the format the CLI produced (jpeg)`);
  const model = b.model ?? defaultModel;
  if (!model) throw new CapitolineError("bad_request", "no image model is configured: set \"model\" explicitly");
  const ignored = Object.keys(b).filter((f) => !HONORED.has(f) && b[f] !== undefined && b[f] !== null);
  return { req: { model, prompt: b.prompt }, ignored };
}

export function imageResponse(ev: ImageEvent, extra: { provider: string; model: string; ignored: string[] }) {
  return {
    created: Math.floor(Date.now() / 1000),
    data: [{ b64_json: ev.bytes.toString("base64") }],
    capitoline: { provider: extra.provider, model: extra.model, mime: ev.mime, width: ev.width, height: ev.height, bytes: ev.bytes.length, ignored: extra.ignored },
  };
}
