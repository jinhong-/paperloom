/**
 * Panel geometry and the wire format for display-ready assets.
 *
 * The hardware is the Good Display ESP32-133C02: a 13.3" 6-colour e-paper panel
 * driven over SPI by an ESP32-S3. This module is the single source of truth
 * for the asset binary layout; the firmware must agree with it exactly.
 *
 * Pixel format
 * ------------
 * The panel is addressed in 4 bits per pixel: two pixels per byte, with the
 * EVEN (left) pixel in the high nibble and the ODD (right) pixel in the low
 * nibble. Rows are contiguous with no padding, so the row stride is exactly
 * `width / 2` bytes.
 *
 *   byte 0: [ p0 (hi) | p1 (lo) ]   pixel x = 0
 *   byte 1: [ p2 (hi) | p3 (lo) ]   pixel x = 2
 *   ...
 *
 * Colour indices are the vendor's 3-bit codes, not a dense palette:
 *
 *   0 = black, 1 = white, 2 = yellow, 3 = red, 4 = reserved, 5 = blue, 6 = green
 *
 * Index 4 is never emitted by the ditherer; the firmware skips it when
 * nearest-colour matching, and it is absent from the palette table below.
 */

/** Width of the panel in pixels (portrait orientation). */
export const PANEL_WIDTH = 1200;

/** Height of the panel in pixels (portrait orientation). */
export const PANEL_HEIGHT = 1600;

/** Bytes per row. Two pixels per byte, no row padding. */
export const ROW_STRIDE_BYTES = PANEL_WIDTH / 2;

/** Size of one unpacked frame buffer in bytes. */
export const RAW_FRAME_BYTES = ROW_STRIDE_BYTES * PANEL_HEIGHT;

/**
 * How far the picture is turned on the panel.
 *
 * The panel itself is always driven in portrait, so a rotation is a
 * change to the picture rather than to the panel: the photo is rendered
 * at the turned dimensions and then turned back so that it lands the
 * right way up.
 */
export const ROTATIONS = [0, 90, 180, 270] as const;

/** A rotation in degrees. */
export type Rotation = (typeof ROTATIONS)[number];

/**
 * Whether a rotation is one the server understands.
 */
export function isRotation(value: unknown): value is Rotation {
  return typeof value === "number" && (ROTATIONS as readonly number[]).includes(value);
}

/**
 * The dimensions a picture is rendered at for a given rotation.
 *
 * A picture turned by ninety degrees is landscape, so it is rendered
 * wider than it is tall, and then turned back into the panel's portrait
 * frame.
 */
export function rotatedSize(rotation: Rotation): { width: number; height: number } {
  return rotation === 90 || rotation === 270
    ? { width: PANEL_HEIGHT, height: PANEL_WIDTH }
    : { width: PANEL_WIDTH, height: PANEL_HEIGHT };
}

/**
 * Number of distinct panel colours (excluding the reserved index 4).
 */
export const PALETTE_SIZE = 6;

/**
 * The vendor colour index for each palette position.
 *
 * The ditherer works with palette *positions* 0-5, but the panel is
 * addressed with the vendor's colour *codes*, which skip 4. This table
 * maps one to the other.
 *
 * Position:  0 black, 1 white, 2 yellow, 3 red, 4 blue, 5 green
 * Code:      0 black, 1 white, 2 yellow, 3 red, 5 blue, 6 green
 */
export const PALETTE_INDICES = [0, 1, 2, 3, 5, 6] as const;

/**
 * The ideal (theoretical) RGB for each palette position.
 *
 * These are the values the reference firmware writes out after dithering, so
 * that a decoded asset is bit-identical to what the device would produce
 * locally. The order matches `PALETTE_INDICES`.
 */
export const THEORETICAL_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], // black
  [255, 255, 255], // white
  [255, 255, 0], // yellow
  [255, 0, 0], // red
  [0, 0, 255], // blue
  [0, 255, 0], // green
];

/**
 * Error-diffusion kernels, ported from the reference firmware.
 *
 * Each entry is `{ dx, dy, numerator, denominator }` describing how much of
 * the quantisation error is pushed onto the neighbouring pixel. The
 * denominator is a constant, so the fractions are exact.
 */
export interface DiffusionKernel {
  readonly dx: number;
  readonly dy: number;
  readonly numerator: number;
  readonly denominator: number;
}

export type DitherAlgorithm = "floyd-steinberg" | "stucki" | "burkes" | "sierra";

export const DITHER_ALGORITHMS: readonly DitherAlgorithm[] = [
  "floyd-steinberg",
  "stucki",
  "burkes",
  "sierra",
];

const FLOYD_STEINBERG: readonly DiffusionKernel[] = [
  { dx: 1, dy: 0, numerator: 7, denominator: 16 },
  { dx: -1, dy: 1, numerator: 3, denominator: 16 },
  { dx: 0, dy: 1, numerator: 5, denominator: 16 },
  { dx: 1, dy: 1, numerator: 1, denominator: 16 },
];

const STUCKI: readonly DiffusionKernel[] = [
  { dx: 1, dy: 0, numerator: 8, denominator: 42 },
  { dx: 2, dy: 0, numerator: 4, denominator: 42 },
  { dx: -2, dy: 1, numerator: 2, denominator: 42 },
  { dx: -1, dy: 1, numerator: 4, denominator: 42 },
  { dx: 0, dy: 1, numerator: 8, denominator: 42 },
  { dx: 1, dy: 1, numerator: 4, denominator: 42 },
  { dx: 2, dy: 1, numerator: 2, denominator: 42 },
  { dx: -2, dy: 2, numerator: 1, denominator: 42 },
  { dx: -1, dy: 2, numerator: 2, denominator: 42 },
  { dx: 0, dy: 2, numerator: 4, denominator: 42 },
  { dx: 1, dy: 2, numerator: 2, denominator: 42 },
  { dx: 2, dy: 2, numerator: 1, denominator: 42 },
];

const BURKES: readonly DiffusionKernel[] = [
  { dx: 1, dy: 0, numerator: 8, denominator: 32 },
  { dx: 2, dy: 0, numerator: 4, denominator: 32 },
  { dx: -2, dy: 1, numerator: 2, denominator: 32 },
  { dx: -1, dy: 1, numerator: 4, denominator: 32 },
  { dx: 0, dy: 1, numerator: 8, denominator: 32 },
  { dx: 1, dy: 1, numerator: 4, denominator: 32 },
  { dx: 2, dy: 1, numerator: 2, denominator: 32 },
];

const SIERRA: readonly DiffusionKernel[] = [
  { dx: 1, dy: 0, numerator: 5, denominator: 32 },
  { dx: 2, dy: 0, numerator: 3, denominator: 32 },
  { dx: -2, dy: 1, numerator: 2, denominator: 32 },
  { dx: -1, dy: 1, numerator: 4, denominator: 32 },
  { dx: 0, dy: 1, numerator: 5, denominator: 32 },
  { dx: 1, dy: 1, numerator: 4, denominator: 32 },
  { dx: 2, dy: 1, numerator: 2, denominator: 32 },
  { dx: -1, dy: 2, numerator: 2, denominator: 32 },
  { dx: 0, dy: 2, numerator: 3, denominator: 32 },
  { dx: 1, dy: 2, numerator: 2, denominator: 32 },
];

export function diffusionKernel(algorithm: DitherAlgorithm): readonly DiffusionKernel[] {
  switch (algorithm) {
    case "stucki":
      return STUCKI;
    case "burkes":
      return BURKES;
    case "sierra":
      return SIERRA;
    case "floyd-steinberg":
    default:
      return FLOYD_STEINBERG;
  }
}

/**
 * The `epdgz` container.
 *
 * An asset is a gzip stream (RFC 1952) whose inflated body is the raw 4bpp
 * frame buffer. The firmware inflates with `inflateInit2(16 + MAX_WBITS)`,
 * which auto-detects gzip framing, so the file may be gzip or zlib wrapped;
 * we always emit gzip so the `.epdgz` extension is meaningful.
 *
 * The inflated body is exactly `RAW_FRAME_BYTES` long and is indexed
 * linearly: `offset = y * ROW_STRIDE_BYTES + (x >> 1)`.
 */
export const EPDGZ_MAGIC = Buffer.from([0x1f, 0x8b]);

/**
 * Pack a row-major sequence of colour indices into the 4bpp panel layout.
 *
 * @param indices Row-major colour indices, `width * height` entries.
 */
export function packIndices(indices: Uint8Array, width = PANEL_WIDTH, height = PANEL_HEIGHT): Buffer {
  if (indices.length !== width * height) {
    throw new Error(`expected ${width * height} indices, got ${indices.length}`);
  }
  const out = Buffer.allocUnsafe((width * height) / 2);
  let o = 0;
  for (let i = 0; i < indices.length; i += 2) {
    const even = indices[i]! & 0x0f;
    const odd = indices[i + 1]! & 0x0f;
    out[o++] = (even << 4) | odd;
  }
  return out;
}

/**
 * Unpack the 4bpp panel layout into row-major colour indices.
 *
 * This is the inverse of `packIndices` and is used by the tests and by the
 * preview renderer.
 */
export function unpackIndices(
  raw: Buffer | Uint8Array,
  width = PANEL_WIDTH,
  height = PANEL_HEIGHT,
): Uint8Array {
  const expected = (width * height) / 2;
  if (raw.length !== expected) {
    throw new Error(`expected ${expected} raw bytes, got ${raw.length}`);
  }
  const out = new Uint8Array(width * height);
  let i = 0;
  for (let b = 0; b < raw.length; b++) {
    out[i++] = (raw[b]! >> 4) & 0x0f;
    out[i++] = raw[b]! & 0x0f;
  }
  return out;
}
