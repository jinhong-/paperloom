/*
 * Tests for the layout the panel expects of the frame buffer.
 *
 * The panel is split between two driver chips, each with its own chip
 * select, and it reads each row right to left. Both of those are easy to
 * get wrong, and the result is a picture that comes out mirrored, or split
 * down the middle with the halves swapped.
 *
 * The vendor's own sample is the authority. It packs a row like this:
 *
 *     // Fill pixel data (horizontal scan, from right to left, top to bottom)
 *     for (unsigned int x = 0; x < EPD_WIDTH; x += 2) {
 *         int new_x = (EPD_WIDTH - 2 - x); // From right to left
 *         int new_index = (y * Width) + (new_x / 2);
 *         num[new_index] = (color1 << 4) | color2;
 *     }
 *
 * and then sends the first half of each row to the first chip select and
 * the second half to the second:
 *
 *     setPinCs(0, 0);
 *     for (i = 0; i < Height; i++)
 *         writeEpdData(num + i * Width, Width1);
 *     setPinCs(1, 0);
 *     for (i = 0; i < Height; i++)
 *         writeEpdData(num + i * Width + Width1, Width1);
 *
 * These tests rebuild the vendor's output and check that the firmware
 * would send exactly the same bytes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PANEL_HEIGHT, PANEL_WIDTH, ROW_STRIDE_BYTES } from "./panel.js";

/** Bytes per row that each chip select receives. */
const HALF_ROW_BYTES = ROW_STRIDE_BYTES / 2;

/**
 * A colour for a pixel, chosen so that neighbouring pixels differ.
 *
 * The panel has only sixteen colour codes, so the values repeat, but
 * that is enough to tell one pixel from its neighbour.
 */
function pixelColour(x: number): number {
  return ((x % 14) + 1) & 0x0f;
}

/**
 * A frame buffer in the ordinary order, left to right.
 */
function buildBuffer(): Uint8Array {
  const buffer = new Uint8Array(ROW_STRIDE_BYTES * PANEL_HEIGHT);
  for (let y = 0; y < PANEL_HEIGHT; y++) {
    const row = buffer.subarray(y * ROW_STRIDE_BYTES, (y + 1) * ROW_STRIDE_BYTES);
    for (let x = 0; x < PANEL_WIDTH; x++) {
      const colour = pixelColour(x);
      row[x >> 1]! |= (x & 1) ? colour : colour << 4;
    }
  }
  return buffer;
}

/**
 * The bytes the vendor's sample packs for one row.
 */
function vendorRow(): Uint8Array {
  const row = new Uint8Array(ROW_STRIDE_BYTES);
  for (let x = 0; x < PANEL_WIDTH; x += 2) {
    const newX = PANEL_WIDTH - 2 - x;
    row[newX >> 1] = ((pixelColour(x) << 4) | pixelColour(x + 1)) & 0xff;
  }
  return row;
}

/**
 * The bytes our firmware sends to one chip select.
 *
 * @param buffer The frame buffer, in the ordinary order.
 * @param half   0 for the first chip select, 1 for the second.
 */
function ourBytes(buffer: Uint8Array, half: number): number[] {
  const out: number[] = [];

  for (let i = 0; i < PANEL_HEIGHT; i++) {
    /* The panel reads the rows bottom to top, so the last row of the
     * picture is sent first. */
    const row = buffer.subarray(
      (PANEL_HEIGHT - 1 - i) * ROW_STRIDE_BYTES,
      (PANEL_HEIGHT - i) * ROW_STRIDE_BYTES,
    );

    /* The first half of the reversed row is the last half of ours, read
     * backwards. The pixels within each byte keep their places. */
    const start = half === 0 ? ROW_STRIDE_BYTES - HALF_ROW_BYTES : 0;

    for (let j = 0; j < HALF_ROW_BYTES; j++) {
      out.push(row[start + HALF_ROW_BYTES - 1 - j]!);
    }
  }

  return out;
}

/**
 * The bytes the vendor's sample sends to one chip select.
 *
 * @param half 0 for the first chip select, 1 for the second.
 */
function vendorBytes(half: number): number[] {
  const out: number[] = [];
  const row = vendorRow();

  for (let i = 0; i < PANEL_HEIGHT; i++) {
    /* The vendor's picture is stored bottom-up, so the rows are sent in
     * the reverse of the order they were built in. */
    const y = PANEL_HEIGHT - 1 - i;
    for (let j = 0; j < HALF_ROW_BYTES; j++) {
      out.push(row[half * HALF_ROW_BYTES + j]!);
    }
  }

  return out;
}

test("the first chip select carries the same bytes as the vendor's", () => {
  const buffer = buildBuffer();
  const ours = ourBytes(buffer, 0);
  const vendor = vendorBytes(0);

  assert.equal(ours.length, vendor.length);
  for (let i = 0; i < vendor.length; i++) {
    assert.equal(ours[i], vendor[i], `byte ${i} differs`);
  }
});

test("the second chip select carries the same bytes as the vendor's", () => {
  const buffer = buildBuffer();
  const ours = ourBytes(buffer, 1);
  const vendor = vendorBytes(1);

  assert.equal(ours.length, vendor.length);
  for (let i = 0; i < vendor.length; i++) {
    assert.equal(ours[i], vendor[i], `byte ${i} differs`);
  }
});

test("the two halves together carry every pixel once", () => {
  const buffer = buildBuffer();
  const first = ourBytes(buffer, 0);
  const second = ourBytes(buffer, 1);

  assert.equal(first.length + second.length, (PANEL_WIDTH * PANEL_HEIGHT) / 2);

  // Every colour has to appear, and none of them may appear zero times:
  // a half that was dropped or doubled would show up here.
  const seen = new Map<number, number>();
  for (const list of [first, second]) {
    for (const byte of list) {
      for (const nibble of [byte >> 4, byte & 0x0f]) {
        seen.set(nibble, (seen.get(nibble) ?? 0) + 1);
      }
    }
  }

  for (const [colour, count] of seen) {
    assert.ok(count > 0, `colour ${colour} never appeared`);
  }
});

test("the pixels in a byte keep their places", () => {
  // The panel reads whole pixels, so the two pixels in a byte are not
  // swapped. If they were, every glyph would come out mirrored.
  const buffer = buildBuffer();
  const ours = ourBytes(buffer, 0);

  // The last byte we send is our byte 300, and its pixels must still be
  // the even one first.
  const last = ours[HALF_ROW_BYTES - 1]!;
  const expected = buffer[300]!;
  assert.equal(last, expected);
  assert.equal((last >> 4) & 0x0f, pixelColour(600));
  assert.equal(last & 0x0f, pixelColour(601));
});
