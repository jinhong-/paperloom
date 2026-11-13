/**
 * Image preparation: photo -> panel-ready 4bpp asset.
 *
 * The pipeline mirrors the reference firmware's `process_rgb_buffer_core`,
 * but runs on the server so the device only ever downloads and pushes bytes:
 *
 *   1. Decode to RGB.
 *   2. Fit to the panel (cover: scale to fill, then centre-crop).
 *   3. Compress dynamic range against the measured panel black/white points.
 *   4. Error-diffusion dither to the six-colour palette.
 *   5. Pack to 4bpp and gzip.
 *
 * Steps 3-5 are ported from the reference implementation so that an asset
 * produced here is visually identical to one produced on-device. The
 * difference is that we quantise against a *perceptual* palette (the panel's
 * measured response) while the device emits the *theoretical* palette; see
 * `renderPalette()` for why both exist.
 */

import { gzipSync } from "node:zlib";
import sharp from "sharp";

import {
  PANEL_HEIGHT,
  PANEL_WIDTH,
  RAW_FRAME_BYTES,
  THEORETICAL_RGB,
  diffusionKernel,
  rotatedSize,
  type DitherAlgorithm,
  type Rotation,
} from "./panel.js";

/**
 * A colour, expressed in sRGB 0-255.
 */
export type Rgb = readonly [number, number, number];

/**
 * Measured panel response: the RGB value each panel colour actually reaches,
 * plus the display's black and white luminance.
 *
 * `black`/`white` are the measured extremes used for dynamic-range
 * compression. When a panel has not been calibrated we fall back to the
 * ideal values, which is what the reference firmware does out of the box.
 */
export interface PanelPalette {
  /** Measured RGB for each of the six panel colours, in `PALETTE_INDICES` order. */
  readonly perceived: readonly Rgb[];
  /** Luminance of the panel's black point (linear, 0-1). */
  readonly blackY: number;
  /** Luminance of the panel's white point (linear, 0-1). */
  readonly whiteY: number;
}

/**
 * The default palette: ideal colours and ideal luminance endpoints.
 */
export const DEFAULT_PALETTE: PanelPalette = {
  perceived: THEORETICAL_RGB,
  blackY: 0,
  whiteY: 1,
};

/**
 * Pick the palette colour closest to an RGB triple.
 *
 * The distance is the plain squared Euclidean distance in sRGB, matching
 * the reference implementation.
 *
 * Linear-light distance was tried and rejected: it weights the green
 * channel far more heavily than the eye's actual sensitivity for a
 * saturated colour, which makes a pure red image dither into a chaotic
 * mix of black, white and yellow instead of clean red.
 */
export function nearestPaletteIndex(
  r: number,
  g: number,
  b: number,
  palette: readonly Rgb[],
): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i]!;
    const dr = r - p[0];
    const dg = g - p[1];
    const db = b - p[2];
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

function linearize(value: number): number {
  const s = value / 255;
  return s > 0.04045 ? Math.pow((s + 0.055) / 1.055, 2.4) : s / 12.92;
}

function delinearize(linear: number): number {
  if (linear <= 0) return 0;
  if (linear >= 1) return 255;
  const s = linear > 0.0031308 ? 1.055 * Math.pow(linear, 1 / 2.4) - 0.055 : 12.92 * linear;
  return Math.round(s * 255);
}

/**
 * Fit an image to the panel, cropping to fill.
 *
 * Uses sharp's `cover` fit, which scales so the image fills the target and
 * crops the overflow from the centre.
 */
export async function fitToPanel(
  input: Buffer,
  width = PANEL_WIDTH,
  height = PANEL_HEIGHT,
): Promise<Buffer> {
  return sharp(input)
    .resize(width, height, { fit: "cover", position: "centre" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then((r) => r.data);
}

/**
 * Compress the dynamic range so the photo spans the panel's actual
 * black-to-white response rather than the ideal 0-255 range.
 *
 * The panel's real black point is above zero and its white point is below
 * 255, so an unmodified photo looks washed out. We remap linear luminance
 * onto `[blackY, whiteY]` and scale the chroma proportionally, which
 * preserves hue and saturation while fitting the range.
 */
export function compressDynamicRange(
  rgb: Buffer,
  palette: PanelPalette = DEFAULT_PALETTE,
): Buffer {
  const out = Buffer.from(rgb);
  const range = palette.whiteY - palette.blackY;

  for (let i = 0; i < out.length; i += 3) {
    const lr = linearize(out[i]!);
    const lg = linearize(out[i + 1]!);
    const lb = linearize(out[i + 2]!);

    const luminance = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
    const compressed = palette.blackY + luminance * range;

    let scale: number;
    if (luminance > 1e-6) {
      scale = compressed / luminance;
    } else {
      // A pure-black pixel has no chroma to scale, so it maps directly to
      // the panel's black point. This is what keeps deep shadows from
      // washing out on a panel whose black is not truly black.
      const black = delinearize(palette.blackY);
      out[i] = black;
      out[i + 1] = black;
      out[i + 2] = black;
      continue;
    }

    out[i] = delinearize(lr * scale);
    out[i + 1] = delinearize(lg * scale);
    out[i + 2] = delinearize(lb * scale);
  }
  return out;
}

/**
 * Error-diffusion dither to the six-colour palette.
 *
 * The error is diffused against the *perceptual* palette (what the panel
 * actually shows) but the selected index is what matters; the caller maps
 * the index to the theoretical RGB when producing a preview.
 *
 * Three scanlines of error state are kept so that kernels reaching two rows
 * ahead (Stucki, Sierra) work correctly.
 *
 * @param rgb        Raw RGB input, `width * height * 3` bytes.
 * @param palette    Perceptual palette to quantise against.
 * @param algorithm  Error-diffusion kernel to use.
 * @returns One palette index per pixel, row-major.
 */
export function ditherToPalette(
  rgb: Buffer,
  palette: readonly Rgb[],
  algorithm: DitherAlgorithm = "floyd-steinberg",
  width = PANEL_WIDTH,
  height = PANEL_HEIGHT,
): Uint8Array {
  const kernel = diffusionKernel(algorithm);
  const out = new Uint8Array(width * height);

  // Error state per channel per scanline. Three lines are needed because the
  // widest kernels diffuse into row y+2.
  //
  // The error is kept as integers and the share is truncated on the way in,
  // exactly as the reference implementation does. Using floating point here
  // accumulates fractions that the reference discards, which makes the
  // output drift apart from the reference after a few rows.
  let current = new Int32Array(width * 3);
  let next = new Int32Array(width * 3);
  let next2 = new Int32Array(width * 3);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = (y * width + x) * 3;
      const error = x * 3;

      let r = rgb[pixel]! + current[error]!;
      let g = rgb[pixel + 1]! + current[error + 1]!;
      let b = rgb[pixel + 2]! + current[error + 2]!;
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;

      const index = nearestPaletteIndex(r, g, b, palette);
      out[y * width + x] = index;

      // The error is measured against the palette entry we chose.
      const chosen = palette[index]!;
      const errR = r - chosen[0];
      const errG = g - chosen[1];
      const errB = b - chosen[2];

      for (const k of kernel) {
        const nx = x + k.dx;
        const ny = y + k.dy;
        if (nx < 0 || nx >= width) continue;

        const target = ny === y ? current : ny === y + 1 ? next : ny === y + 2 ? next2 : null;
        if (!target) continue;

        const ti = nx * 3;
        target[ti] = target[ti]! + Math.trunc((errR * k.numerator) / k.denominator);
        target[ti + 1] = target[ti + 1]! + Math.trunc((errG * k.numerator) / k.denominator);
        target[ti + 2] = target[ti + 2]! + Math.trunc((errB * k.numerator) / k.denominator);
      }
    }

    // Roll the scanline buffers forward.
    const spare = current;
    current = next;
    next = next2;
    next2 = spare;
    next2.fill(0);
  }

  return out;
}

/**
 * Produce the display-ready asset bytes for an image.
 *
 * The result is a gzip stream whose inflated body is the 4bpp frame buffer.
 */
export async function renderAsset(
  input: Buffer,
  options: {
    readonly dither?: DitherAlgorithm;
    readonly palette?: PanelPalette;
    readonly compressRange?: boolean;
    /** How far the picture is turned on the panel. */
    readonly rotation?: Rotation;
  } = {},
): Promise<{ data: Buffer; raw: Buffer; indices: Uint8Array }> {
  const palette = options.palette ?? DEFAULT_PALETTE;
  const compressRange = options.compressRange ?? true;
  const rotation = options.rotation ?? 0;

  /* A turned picture is rendered at the turned dimensions, so that it
   * fills the panel rather than being letterboxed inside it. */
  const target = rotatedSize(rotation);

  let rgb = await fitToPanel(input, target.width, target.height);
  if (compressRange) {
    rgb = compressDynamicRange(rgb, palette);
  }

  let indices = ditherToPalette(rgb, palette.perceived, options.dither ?? "floyd-steinberg");

  /* The ditherer works in the picture's own orientation. Turning the
   * colours afterwards would break up the error diffusion, so the picture
   * is turned first and then dithered, which keeps the dithering as good
   * as it would have been without the turn. */
  if (rotation !== 0) {
    indices = rotateIndices(indices, target.width, target.height, rotation);
  }

  const raw = packIndicesFrom(indices);
  const data = gzipSync(raw, { level: 9 });

  return { data, raw, indices };
}

/**
 * Turn a picture by a quarter of a turn, or by half of one.
 *
 * The result is the panel's portrait frame, so a picture that was
 * rendered landscape comes out as a portrait image with the picture
 * turned the right way up.
 *
 * @param indices Row-major colour indices.
 * @param width   The width of the picture being turned.
 * @param height  The height of the picture being turned.
 * @param rotation How far to turn it.
 */
export function rotateIndices(
  indices: Uint8Array,
  width: number,
  height: number,
  rotation: Rotation,
): Uint8Array {
  if (rotation === 0) return indices;

  const outWidth = rotation === 90 || rotation === 270 ? height : width;
  const outHeight = rotation === 90 || rotation === 270 ? width : height;
  const out = new Uint8Array(outWidth * outHeight);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let outX = 0;
      let outY = 0;

      switch (rotation) {
        case 90:
          // A quarter turn clockwise.
          outX = height - 1 - y;
          outY = x;
          break;
        case 180:
          outX = width - 1 - x;
          outY = height - 1 - y;
          break;
        case 270:
          // A quarter turn anticlockwise.
          outX = y;
          outY = width - 1 - x;
          break;
      }

      out[outY * outWidth + outX] = indices[y * width + x]!;
    }
  }

  return out;
}

/**
 * Pack palette positions into the 4bpp panel layout.
 *
 * The ditherer produces palette *positions* 0-5, but the panel is
 * addressed with the vendor's colour *codes*, which skip 4. The positions
 * are translated through `PALETTE_INDICES` here, so the asset contains
 * only codes the panel actually has.
 *
 * Kept local to avoid a circular import between this module and `panel.ts`
 * at the value level (the packer is pure and has no dependencies).
 */
function packIndicesFrom(indices: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(indices.length / 2);
  let o = 0;
  for (let i = 0; i < indices.length; i += 2) {
    const even = PANEL_CODES[indices[i]!] ?? PANEL_CODES[1]!;
    const odd = PANEL_CODES[indices[i + 1]!] ?? PANEL_CODES[1]!;
    out[o++] = (even << 4) | odd;
  }
  return out;
}

/**
 * The vendor colour code for each palette position.
 *
 * Position 4 (blue) is code 5; code 4 is reserved by the vendor and is
 * never written to the panel.
 */
const PANEL_CODES = [0, 1, 2, 3, 5, 6] as const;

/**
 * Render a preview PNG of what the device will show.
 *
 * Used by the management UI so an operator can see the dithered result
 * without flashing it to the panel.
 */
export async function renderPreview(
  indices: Uint8Array,
  width = PANEL_WIDTH,
  height = PANEL_HEIGHT,
): Promise<Buffer> {
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0; i < indices.length; i++) {
    const c = THEORETICAL_RGB[indices[i]!] ?? THEORETICAL_RGB[1]!;
    rgb[i * 3] = c[0];
    rgb[i * 3 + 1] = c[1];
    rgb[i * 3 + 2] = c[2];
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

export { RAW_FRAME_BYTES };
