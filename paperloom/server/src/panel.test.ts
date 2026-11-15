/**
 * Tests for the panel packing format.
 *
 * These are the highest-risk tests in the project: if the packing layout
 * disagrees with the firmware by even one bit, the panel shows noise.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PANEL_HEIGHT,
  PANEL_WIDTH,
  RAW_FRAME_BYTES,
  ROW_STRIDE_BYTES,
  packIndices,
  unpackIndices,
} from "./panel.js";

test("row stride packs two pixels per byte", () => {
  assert.equal(ROW_STRIDE_BYTES, 600);
  assert.equal(RAW_FRAME_BYTES, 960_000);
  assert.equal(RAW_FRAME_BYTES, (PANEL_WIDTH * PANEL_HEIGHT) / 2);
});

test("even pixel is in the high nibble, odd in the low nibble", () => {
  const indices = new Uint8Array([0x3, 0x6, 0x1, 0x0]);
  const packed = packIndices(indices, 4, 1);
  assert.deepEqual([...packed], [0x36, 0x10]);
});

test("unpack is the exact inverse of pack", () => {
  const width = 16;
  const height = 4;
  const indices = new Uint8Array(width * height);
  for (let i = 0; i < indices.length; i++) {
    indices[i] = [0, 1, 2, 3, 5, 6][i % 6]!;
  }
  const round = unpackIndices(packIndices(indices, width, height), width, height);
  assert.deepEqual([...round], [...indices]);
});

test("packing rejects a mismatched index count", () => {
  assert.throws(() => packIndices(new Uint8Array(3), 4, 1), /expected 4 indices/);
});
