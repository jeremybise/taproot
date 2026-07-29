import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { readImageDimensions } from './imageSize.js';

/**
 * Fixtures are built byte by byte rather than checked in as binary files.
 *
 * A committed `.png` would make it impossible to see, in a diff, what the parser is actually being
 * asked to read — and these tests exist to pin down exactly which bytes matter.
 */

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function pngFixture(width: number, height: number): Uint8Array {
  const ihdr = concat([u32(width), u32(height), new Uint8Array([8, 2, 0, 0, 0])]);
  const chunk = (type: string, data: Uint8Array) =>
    concat([
      u32(data.length),
      new Uint8Array([...type].map((c) => c.charCodeAt(0))),
      data,
      u32(0), // CRC is not read by a header parser, so it is left zero.
    ]);

  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(new Uint8Array(height * (1 + width * 3))))),
  ]);
}

function gifFixture(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([...'GIF89a'].map((c) => c.charCodeAt(0)));
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

/** A JPEG whose SOF0 sits behind a variable-length APP0 segment, as a real one does. */
function jpegFixture(width: number, height: number, leadingSegments = 1): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];

  for (let i = 0; i < leadingSegments; i++) {
    const payload = new Uint8Array(14 + i * 7);
    const segment = new Uint8Array(4 + payload.length);
    segment.set([0xff, 0xe0]);
    new DataView(segment.buffer).setUint16(2, payload.length + 2);
    segment.set(payload, 4);
    parts.push(segment);
  }

  const sof = new Uint8Array(11);
  sof.set([0xff, 0xc0]);
  const view = new DataView(sof.buffer);
  view.setUint16(2, 9); // length
  sof[4] = 8; // precision
  view.setUint16(5, height);
  view.setUint16(7, width);
  sof[9] = 3; // components
  parts.push(sof);

  return concat(parts);
}

function webpLossyFixture(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  bytes.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8);
  bytes.set([...'VP8 '].map((c) => c.charCodeAt(0)), 12);
  const view = new DataView(bytes.buffer);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytes;
}

describe('readImageDimensions', () => {
  it('reads a PNG', () => {
    expect(readImageDimensions(pngFixture(1200, 630))).toEqual({ width: 1200, height: 630 });
  });

  it('reads a GIF', () => {
    expect(readImageDimensions(gifFixture(64, 48))).toEqual({ width: 64, height: 48 });
  });

  it('reads a lossy WebP', () => {
    expect(readImageDimensions(webpLossyFixture(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it('reads a JPEG', () => {
    expect(readImageDimensions(jpegFixture(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it('skips past variable-length JPEG segments to reach the frame header', () => {
    // There is no fixed offset: EXIF, comments, and quantisation tables all come first and vary.
    for (const segments of [0, 1, 4, 12]) {
      expect(readImageDimensions(jpegFixture(640, 480, segments))).toEqual({
        width: 640,
        height: 480,
      });
    }
  });

  it('does not confuse width and height', () => {
    // The single most likely bug, and invisible on a square fixture.
    expect(readImageDimensions(pngFixture(100, 200))).toEqual({ width: 100, height: 200 });
    expect(readImageDimensions(jpegFixture(100, 200))).toEqual({ width: 100, height: 200 });
    expect(readImageDimensions(gifFixture(100, 200))).toEqual({ width: 100, height: 200 });
  });

  it('returns null rather than throwing on anything unrecognised', () => {
    // An unknown format is not an upload failure; the crop editor simply degrades.
    for (const input of [
      new Uint8Array(0),
      new Uint8Array([1, 2, 3]),
      new Uint8Array(64),
      new TextEncoder().encode('%PDF-1.7\nnot an image'),
    ]) {
      expect(readImageDimensions(input)).toBeNull();
    }
  });

  it('does not loop forever on a truncated JPEG', () => {
    const truncated = jpegFixture(100, 100).slice(0, 6);
    expect(readImageDimensions(truncated)).toBeNull();
  });

  it('does not loop forever on a JPEG with a zero-length segment', () => {
    // A malformed length of 0 would advance the cursor by 2 and re-read the same marker forever.
    const bytes = new Uint8Array(40);
    bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]);
    expect(readImageDimensions(bytes)).toBeNull();
  });
});
