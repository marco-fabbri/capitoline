// Sanity check of the bytes collected from a CLI's conversation directory before they are
// returned to a client: format signature, minimum size and pixel dimensions read from the
// headers. No decoding library: JPEG frame headers and the PNG IHDR are a few bytes each.

export interface ImageInfo {
  mime: "image/jpeg" | "image/png";
  width: number;
  height: number;
  bytes: number;
}

export type ImageVerdict = { ok: true; info: ImageInfo } | { ok: false; reason: string };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

function isPng(buf: Buffer): boolean {
  return buf.length >= PNG_SIGNATURE.length && buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

// Start-of-frame markers: C0..CF except DHT (C4), JPG (C8) and DAC (CC). Baseline (C0) and
// progressive (C2) are what the CLI produces; the others are accepted for free.
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

// Walks the marker segments after SOI up to the first SOF and reads its height/width.
// Returns null on anything malformed or truncated, or if SOS/EOI arrive before a frame header.
function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  let pos = 2;
  for (;;) {
    if (pos + 4 > buf.length || buf[pos] !== 0xff) return null;
    let marker = buf[pos + 1]!;
    // Fill bytes: any number of 0xFF may precede a marker code.
    while (marker === 0xff) {
      pos++;
      if (pos + 4 > buf.length) return null;
      marker = buf[pos + 1]!;
    }
    // Standalone markers without a length field: TEM, RSTn, SOI. Not expected here but legal.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { pos += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI or SOS before any frame header
    const length = buf.readUInt16BE(pos + 2);
    if (length < 2 || pos + 2 + length > buf.length) return null;
    if (isSofMarker(marker)) {
      if (length < 7) return null; // precision(1) + height(2) + width(2) at least
      const height = buf.readUInt16BE(pos + 5);
      const width = buf.readUInt16BE(pos + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    pos += 2 + length;
  }
}

// PNG: the IHDR chunk must come first: length(4) "IHDR"(4) width(4) height(4) ...
function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function inspectImage(buf: Buffer, opts: { minBytes: number }): ImageVerdict {
  const mime: ImageInfo["mime"] | null = isJpeg(buf) ? "image/jpeg" : isPng(buf) ? "image/png" : null;
  if (mime === null) return { ok: false, reason: "not a JPEG or PNG" };
  if (buf.length < opts.minBytes) return { ok: false, reason: `too small: ${buf.length} bytes < ${opts.minBytes}` };
  const dims = mime === "image/jpeg" ? jpegDimensions(buf) : pngDimensions(buf);
  if (dims === null) return { ok: false, reason: "unreadable dimensions" };
  return { ok: true, info: { mime, width: dims.width, height: dims.height, bytes: buf.length } };
}
