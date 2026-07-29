/**
 * Read an image's pixel dimensions from its header bytes.
 *
 * Needed because the hotspot/crop model is resolution-independent but not *aspect*-independent:
 * fitting a 16:9 frame inside a crop requires knowing the source's real proportions, and a
 * normalised crop rectangle alone cannot supply them.
 *
 * Header parsing rather than a decoder: dimensions live in the first few dozen bytes of every
 * format here, so there is nothing to gain from decoding pixels and a native dependency to avoid.
 * `sharp` and `image-size`'s native paths are both ruled out by the zero-native-dependency rule,
 * and this runs identically in Node and on Workers.
 *
 * Returns `null` for anything it does not recognise — an unknown format is not an error, it just
 * means the crop editor falls back to the browser's own idea of the aspect ratio.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return png(bytes) ?? gif(bytes) ?? webp(bytes) ?? jpeg(bytes);
}

/** PNG: an 8-byte signature, then IHDR carrying width and height as big-endian uint32. */
function png(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, i) => bytes[i] === byte)) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** GIF: `GIF87a`/`GIF89a`, then width and height as little-endian uint16. */
function gif(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10) return null;
  if (String.fromCharCode(...bytes.slice(0, 3)) !== 'GIF') return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

/**
 * WebP: a RIFF container whose dimensions sit at a different offset per sub-format.
 *
 * Three exist. `VP8 ` is lossy, `VP8L` lossless with the size bit-packed into 14-bit fields, and
 * `VP8X` the extended form used for animation and alpha, which stores size minus one.
 */
function webp(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null;
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WEBP') return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = ascii(12, 16);

  if (format === 'VP8 ') {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }

  if (format === 'VP8L') {
    const packed = view.getUint32(21, true);
    return { width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1 };
  }

  if (format === 'VP8X') {
    const read24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
    return { width: read24(24) + 1, height: read24(27) + 1 };
  }

  return null;
}

/**
 * JPEG: walk the marker segments to the frame header.
 *
 * There is no fixed offset — comment, EXIF, and quantisation-table segments come first and vary in
 * length — so the segments are skipped by their declared length until an SOF marker appears. SOF0
 * through SOF15 all carry dimensions in the same place; DHT, DAC, and the restart markers do not
 * and are excluded.
 */
function jpeg(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  while (offset + 9 < bytes.length) {
    // Segments start with 0xFF; padding bytes of 0xFF are legal and skipped.
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset++;
      continue;
    }

    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isFrameHeader) {
      // length(2) precision(1) height(2) width(2)
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }

    const length = view.getUint16(offset + 2);
    // A zero or negative-looking length would loop forever; give up rather than spin.
    if (length < 2) return null;
    offset += 2 + length;
  }

  return null;
}
