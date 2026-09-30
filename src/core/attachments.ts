import { CapitolineError, type Attachment } from "./types.js";

/**
 * The images a request may carry to a model, whichever transport brought them
 * (a data URL in an OpenAI body, an `images` entry of the MCP ask_model tool).
 * One set of rules, checked in Core before any CLI is started: the transports
 * only decode.
 *
 * The four types are the ones every CLI that takes images accepts. The count
 * and the size are the gateway's own bounds: an image travels as base64 inside
 * a JSON body limited to 20 MB (src/server/app.ts), and a CLI run is one
 * question, not an album.
 */
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** The media type without parameters, lower case: "image/JPEG; q=1" is image/jpeg. */
export function mimeOf(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

// Only own keys of EXT count, so "__proto__" or "constructor" cannot name a file.
export function extensionFor(mime: string): string {
  const key = mimeOf(mime);
  return Object.hasOwn(EXT, key) ? EXT[key] : "bin";
}

// Buffer.from(…, "base64") skips what it cannot read instead of failing, so a
// corrupted image would reach the model as a shorter, broken one.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** The bytes of a base64 string, or null when it is not one (line breaks allowed). */
export function decodeBase64(data: string): Buffer | null {
  const s = data.replace(/\s+/g, "");
  if (s.length === 0 || s.length % 4 !== 0 || !BASE64.test(s)) return null;
  return Buffer.from(s, "base64");
}

/** Refuses, with the reason, what no CLI should be handed. */
export function checkAttachments(attachments: Attachment[], model: string): void {
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new CapitolineError("bad_request", `model "${model}" was sent ${attachments.length} images: at most ${MAX_ATTACHMENTS} per request`);
  }
  attachments.forEach((a, i) => {
    if (!Object.hasOwn(EXT, mimeOf(a.mime))) {
      throw new CapitolineError("bad_request", `image ${i + 1} is ${mimeOf(a.mime) || "of no type"}: only ${Object.keys(EXT).join(", ")} are accepted`);
    }
    if (a.bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new CapitolineError("bad_request", `image ${i + 1} is ${a.bytes.length} bytes: at most ${MAX_ATTACHMENT_BYTES} per image`);
    }
    if (a.bytes.length === 0) throw new CapitolineError("bad_request", `image ${i + 1} is empty`);
  });
}

/** The files the runner writes into the sandbox, by the names an adapter passes to its CLI. */
export function attachmentFiles(attachments: Attachment[] | undefined): { name: string; mime: string; bytes: Buffer }[] {
  return (attachments ?? []).map((a, i) => ({ name: `attachment-${i + 1}.${extensionFor(a.mime)}`, mime: mimeOf(a.mime), bytes: a.bytes }));
}
