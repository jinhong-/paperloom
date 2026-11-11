/**
 * Tests for the image pipeline.
 *
 * These verify the properties the device depends on: the asset is a gzip
 * stream that inflates to exactly one frame of 4bpp data, and the pixels
 * use only valid panel colour indices.
 */

import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";

import sharp from "sharp";

import { PANEL_HEIGHT, PANEL_WIDTH, RAW_FRAME_BYTES, THEORETICAL_RGB, unpackIndices } from "./panel.js";
import {
  compressDynamicRange,
  DEFAULT_PALETTE,
  ditherToPalette,
  nearestPaletteIndex,
  renderAsset,
} from "./image.js";

/**
 * Build a test image: a horizontal gradient from black to white.
 */
async function gradient(width = 600, height = 400): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = Math.round((x / (width - 1)) * 255);
      const i = (y * width + x) * 3;
      raw[i] = value;
      raw[i + 1] = value;
      raw[i + 2] = value;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

test("nearestPaletteIndex finds exact palette matches", () => {
  assert.equal(nearestPaletteIndex(0, 0, 0, THEORETICAL_RGB), 0);
  assert.equal(nearestPaletteIndex(255, 255, 255, THEORETICAL_RGB), 1);
  assert.equal(nearestPaletteIndex(255, 255, 0, THEORETICAL_RGB), 2);
  assert.equal(nearestPaletteIndex(255, 0, 0, THEORETICAL_RGB), 3);
  assert.equal(nearestPaletteIndex(0, 0, 255, THEORETICAL_RGB), 4);
  assert.equal(nearestPaletteIndex(0, 255, 0, THEORETICAL_RGB), 5);
});

test("dithering produces only valid palette indices", () => {
  const width = 32;
  const height = 32;
  const rgb = Buffer.alloc(width * height * 3, 128);
  const indices = ditherToPalette(rgb, THEORETICAL_RGB, "floyd-steinberg", width, height);
  assert.equal(indices.length, width * height);
  for (const index of indices) {
    assert.ok(index < THEORETICAL_RGB.length, `index ${index} is out of range`);
  }
});

test("dithering a mid-grey yields a mix of black and white", () => {
  const width = 64;
  const height = 64;
  const rgb = Buffer.alloc(width * height * 3, 128);
  const indices = ditherToPalette(rgb, THEORETICAL_RGB, "floyd-steinberg", width, height);

  const counts = new Map<number, number>();
  for (const index of indices) {
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  // A grey must dither into a mix, not a single flat colour.
  assert.ok((counts.get(0) ?? 0) > 0, "expected some black pixels");
  assert.ok((counts.get(1) ?? 0) > 0, "expected some white pixels");
});

test("every dither kernel produces a valid result", () => {
  const width = 24;
  const height = 24;
  const rgb = Buffer.alloc(width * height * 3, 90);
  for (const algorithm of ["floyd-steinberg", "stucki", "burkes", "sierra"] as const) {
    const indices = ditherToPalette(rgb, THEORETICAL_RGB, algorithm, width, height);
    assert.equal(indices.length, width * height);
    for (const index of indices) {
      assert.ok(index < THEORETICAL_RGB.length);
    }
  }
});

test("dynamic range compression maps pure white to the panel white point", () => {
  const rgb = Buffer.from([255, 255, 255]);
  const compressed = compressDynamicRange(rgb, DEFAULT_PALETTE);
  assert.equal(compressed[0], 255);
  assert.equal(compressed[1], 255);
  assert.equal(compressed[2], 255);
});

test("dynamic range compression maps the source range onto the panel range", () => {
  // The panel's white point is below 1.0, so a source white is pulled down
  // to match what the panel can actually show.
  const palette = { ...DEFAULT_PALETTE, whiteY: 0.78 };
  const rgb = Buffer.from([255, 255, 255]);
  const compressed = compressDynamicRange(rgb, palette);
  assert.ok(compressed[0]! < 255, "pure white must be pulled down to the panel's white point");
  assert.ok(compressed[0]! > 200, "but it must stay bright");
});

test("dynamic range compression lifts shadows off the panel's black point", () => {
  // A panel whose black point is above zero renders a pure-black pixel as
  // washed-out grey, so the compression must raise it to the black point.
  const palette = { ...DEFAULT_PALETTE, blackY: 0.05 };
  const rgb = Buffer.from([0, 0, 0]);
  const compressed = compressDynamicRange(rgb, palette);
  assert.ok(compressed[0]! > 0, "pure black must be raised to the panel's black point");
  // 0.05 linear is around sRGB 63, which is still clearly a dark tone.
  assert.ok(compressed[0]! <= 70, "but it must stay dark");
});

test("dynamic range compression leaves a mid-grey roughly where it was", () => {
  const rgb = Buffer.from([128, 128, 128]);
  const compressed = compressDynamicRange(rgb, DEFAULT_PALETTE);
  // The default palette spans the full range, so a mid-grey is unchanged.
  assert.ok(Math.abs(compressed[0]! - 128) <= 2);
});

test("renderAsset produces a gzip stream of exactly one frame", async () => {
  const image = await gradient();
  const { data, raw, indices } = await renderAsset(image);

  // The gzip magic bytes.
  assert.equal(data[0], 0x1f);
  assert.equal(data[1], 0x8b);

  // The inflated body must be exactly one frame.
  const inflated = gunzipSync(data);
  assert.equal(inflated.length, RAW_FRAME_BYTES);
  assert.equal(raw.length, RAW_FRAME_BYTES);

  // And it must unpack to one index per pixel.
  const unpacked = unpackIndices(inflated);
  assert.equal(unpacked.length, PANEL_WIDTH * PANEL_HEIGHT);
  assert.equal(unpacked.length, indices.length);
});

test("renderAsset uses only valid colour indices", async () => {
  const image = await gradient();
  const { indices } = await renderAsset(image);
  for (const index of indices) {
    assert.ok(index < THEORETICAL_RGB.length, `index ${index} is out of range`);
  }
});

test("renderAsset is deterministic", async () => {
  const image = await gradient();
  const a = await renderAsset(image);
  const b = await renderAsset(image);
  assert.deepEqual(a.data, b.data, "the same input must produce identical bytes");
});

test("the compressed asset is much smaller than the raw frame", async () => {
  const image = await gradient();
  const { data } = await renderAsset(image);
  assert.ok(data.length < RAW_FRAME_BYTES, "gzip should compress the frame");
});
