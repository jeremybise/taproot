import { deflateSync } from 'node:zlib';

/**
 * A minimal PNG encoder, used only by the seed.
 *
 * Why hand-rolled: Taproot has zero native dependencies, and every image library that could
 * produce a file here (`sharp`, `canvas`) is a native module that would break `npm install` on a
 * machine without a C++ toolchain — the one constraint the whole storage layer is built around.
 * Node's own `zlib` is all a PNG actually needs, so the encoder is smaller than the dependency
 * argument would be.
 *
 * Why an image at all: the media library is otherwise empty on a fresh clone, which leaves the SEO
 * panel's social-card preview, the content type's default-image picker, and the media hotspot
 * editor with nothing to demonstrate. One generated asset unblocks all three.
 *
 * This encodes 8-bit truecolour with no interlacing — the simplest form the spec allows. It is not
 * a general-purpose encoder and should not grow into one; anything more belongs in a real library
 * on the host site's side.
 */

/** Build a PNG from a pixel function. Returns the complete file bytes. */
export function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Uint8Array {
  // Each scanline is prefixed with a filter byte. 0 means "no filtering", which costs some
  // compression ratio and saves implementing the five filter types.
  const raw = new Uint8Array(height * (1 + width * 3));
  let offset = 0;

  for (let y = 0; y < height; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // compression: deflate, the only value the spec defines
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlacing

  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** A PNG chunk: length, type, data, CRC over type+data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
  const body = concat([typeBytes, data]);

  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));

  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The seed's social card: a diagonal gradient in the demo site's green, with a lighter band.
 *
 * Deliberately abstract rather than an attempt at a logo or text — it exists to prove the image
 * pipeline works end to end, and a recognisable graphic would imply the seed ships branding.
 */
export function socialCardPng(width = 1200, height = 630): Uint8Array {
  return encodePng(width, height, (x, y) => {
    const t = (x / width) * 0.6 + (y / height) * 0.4;
    const band = Math.abs(y / height - 0.5 + (x / width - 0.5) * 0.35) < 0.06 ? 26 : 0;

    return [
      Math.round(26 + t * 34 + band),
      Math.round(74 + t * 62 + band),
      Math.round(56 + t * 40 + band),
    ];
  });
}

/**
 * A placeholder "photograph" for the media library, distinct per seed.
 *
 * The picker is a grid, and a grid of one asset demonstrates nothing — you cannot tell whether
 * selection, ordering, or search work until there are several things to tell apart. These have to
 * be visually distinguishable at thumbnail size, hence a per-asset hue and a diagonal split rather
 * than one gradient with the numbers changed.
 *
 * Still deliberately abstract: a seed that shipped recognisable photography would be shipping
 * content, and every asset here is something a real site replaces immediately.
 */
export function placeholderPng(
  hue: number,
  width: number,
  height: number,
): Uint8Array {
  return encodePng(width, height, (x, y) => {
    const u = x / width;
    const v = y / height;
    // A soft diagonal split gives each thumbnail a recognisable shape as well as a colour, which
    // is what makes them distinguishable to someone who cannot rely on hue.
    const split = u * 0.7 + v * 0.3;
    const light = split > 0.55 ? 0.26 : 0;
    return hsl(hue + split * 24, 0.32, 0.36 + light + v * 0.08);
  });
}

/** HSL to 8-bit RGB. Only the seed needs this, so it stays here rather than in core. */
function hsl(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round(Math.min(255, Math.max(0, (r + m) * 255))),
    Math.round(Math.min(255, Math.max(0, (g + m) * 255))),
    Math.round(Math.min(255, Math.max(0, (b + m) * 255))),
  ];
}
