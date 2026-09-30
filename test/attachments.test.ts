import { describe, it, expect } from "vitest";
import { attachmentFiles, checkAttachments, decodeBase64 } from "../src/core/attachments.js";

describe("attachments", () => {
  it("decodes base64, line breaks included, and refuses what is not", () => {
    expect(decodeBase64(Buffer.from("hello!").toString("base64"))).toEqual(Buffer.from("hello!"));
    expect(decodeBase64("aGVs\nbG8h")).toEqual(Buffer.from("hello!"));
    expect(decodeBase64("not base64!!")).toBeNull();
    expect(decodeBase64("abc")).toBeNull();
    expect(decodeBase64("")).toBeNull();
  });
  it("names the files as the CLIs are told, with the media type cleaned", () => {
    expect(attachmentFiles([{ mime: "image/JPEG; q=1", bytes: Buffer.from("a") }, { mime: "image/webp", bytes: Buffer.from("b") }]).map(({ name, mime }) => [name, mime]))
      .toEqual([["attachment-1.jpg", "image/jpeg"], ["attachment-2.webp", "image/webp"]]);
  });
  it("refuses too many images, one of another type, one too large, and an empty one", () => {
    const img = { mime: "image/png", bytes: Buffer.from("x") };
    expect(() => checkAttachments([img, img, img, img], "m")).not.toThrow();
    expect(() => checkAttachments(Array(8).fill(img), "m")).not.toThrow();
    expect(() => checkAttachments(Array(9).fill(img), "m")).toThrow(/at most 8/);
    expect(() => checkAttachments([{ mime: "application/pdf", bytes: Buffer.from("x") }], "m")).toThrow(/application\/pdf: only image\/png/);
    expect(() => checkAttachments([{ mime: "image/png", bytes: Buffer.alloc(10 * 1024 * 1024 + 1) }], "m")).toThrow(/at most 10485760/);
    expect(() => checkAttachments([{ mime: "image/png", bytes: Buffer.alloc(0) }], "m")).toThrow(/empty/);
  });
});
