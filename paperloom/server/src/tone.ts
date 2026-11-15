/**
 * The picture pipeline.
 *
 * This is the reference project's `epaper-image-convert` algorithm, ported
 * so that a picture prepared here looks the same as one prepared by the
 * reference firmware. The reference is the authority on how a picture
 * should look on this panel, and the panel is the same, so the algorithm
 * comes from there rather than being invented.
 *
 * The pipeline, in order:
 *
 *   1. Fit the picture to the panel. A picture that is not the shape of
 *      the panel is fitted inside it and the rest is left blank, rather
 *      than being cropped: a landscape picture on a portrait panel should
 *      not lose its edges.
 *   2. Exposure.
 *   3. Saturation.
 *   4. Tone mapping: an S-curve, or a plain contrast curve.
 *   5. Compress the dynamic range onto the panel's own black and white.
 *   6. Choose the nearest panel colour for each pixel, by Delta-E in LAB
 *      space, so that a colour is chosen by how it looks rather than by
 *      the distance between the numbers.
 *   7. Error-diffusion dither to the palette.
 *
 * The last two steps are in `image.ts`; this module holds the parts that
 * decide what the picture looks like before the palette is applied.
 */

/** How the picture is prepared. */
export interface ToneParams {
  /** How much brighter the picture is. 1 leaves it alone. */
  readonly exposure: number;
  /** How much more colourful the picture is. 1 leaves it alone. */
  readonly saturation: number;
  /** Which curve the tone is mapped with. */
  readonly toneMode: "contrast" | "scurve";
  /** How much the contrast is raised, in the plain contrast curve. */
  readonly contrast: number;
  /** How much the S-curve bends. */
  readonly strength: number;
  /** How much the shadows are lifted, in the S-curve. */
  readonly shadowBoost: number;
  /** How much the highlights are brought down, in the S-curve. */
  readonly highlightCompress: number;
  /** Where the S-curve bends, from 0 (dark) to 1 (light). */
  readonly midpoint: number;
  /** How the panel colour is chosen for a pixel. */
  readonly colorMethod: "rgb" | "lab";
  /** Whether the range is squeezed onto the panel's own black and white. */
  readonly compressDynamicRange: boolean;
}

/**
 * The ways a picture can be prepared.
 *
 * These are the reference project's presets, with the same names and the
 * same settings, so that a picture looks the same whichever way it was
 * prepared.
 */
export const PRESETS: Readonly<Record<string, ToneParams>> = {
  balanced: {
    exposure: 1.0,
    saturation: 1.0,
    toneMode: "contrast",
    contrast: 1.0,
    strength: 0.9,
    shadowBoost: 0.0,
    highlightCompress: 1.5,
    midpoint: 0.5,
    colorMethod: "rgb",
    compressDynamicRange: true,
  },
  dynamic: {
    exposure: 1.0,
    saturation: 1.3,
    toneMode: "scurve",
    contrast: 1.0,
    strength: 0.9,
    shadowBoost: 0.0,
    highlightCompress: 1.5,
    midpoint: 0.5,
    colorMethod: "rgb",
    compressDynamicRange: false,
  },
  vivid: {
    exposure: 1.1,
    saturation: 1.6,
    toneMode: "scurve",
    contrast: 1.0,
    strength: 0.7,
    shadowBoost: 0.1,
    highlightCompress: 1.3,
    midpoint: 0.5,
    colorMethod: "rgb",
    compressDynamicRange: false,
  },
  soft: {
    exposure: 1.0,
    saturation: 1.1,
    toneMode: "contrast",
    contrast: 0.9,
    strength: 0.9,
    shadowBoost: 0.0,
    highlightCompress: 1.5,
    midpoint: 0.5,
    colorMethod: "rgb",
    compressDynamicRange: true,
  },
  grayscale: {
    exposure: 1.0,
    saturation: 0.0,
    toneMode: "scurve",
    contrast: 1.0,
    strength: 0.8,
    shadowBoost: 0.1,
    highlightCompress: 1.4,
    midpoint: 0.5,
    colorMethod: "lab",
    compressDynamicRange: true,
  },
};

/** The preset a picture gets when nothing else is chosen. */
export const DEFAULT_PRESET = "balanced";

/**
 * The settings for a preset, or the balanced ones when the name is not
 * one we know.
 */
export function toneParamsFor(preset: string | null | undefined): ToneParams {
  const found = preset !== null && preset !== undefined ? PRESETS[preset] : undefined;
  return found ?? PRESETS[DEFAULT_PRESET]!;
}

/**
 * Convert an sRGB value to CIE XYZ.
 */
export function rgbToXyz(r: number, g: number, b: number): [number, number, number] {
  let rr = r / 255;
  let gg = g / 255;
  let bb = b / 255;

  rr = rr > 0.04045 ? Math.pow((rr + 0.055) / 1.055, 2.4) : rr / 12.92;
  gg = gg > 0.04045 ? Math.pow((gg + 0.055) / 1.055, 2.4) : gg / 12.92;
  bb = bb > 0.04045 ? Math.pow((bb + 0.055) / 1.055, 2.4) : bb / 12.92;

  const x = rr * 0.4124564 + gg * 0.3575761 + bb * 0.1804375;
  const y = rr * 0.2126729 + gg * 0.7151522 + bb * 0.072175;
  const z = rr * 0.0193339 + gg * 0.119192 + bb * 0.9503041;

  return [x * 100, y * 100, z * 100];
}

/**
 * Convert CIE XYZ to CIE LAB.
 */
export function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  const xx = x / 95.047;
  const yy = y / 100.0;
  const zz = z / 108.883;

  const fx = xx > 0.008856 ? Math.pow(xx, 1 / 3) : 7.787 * xx + 16 / 116;
  const fy = yy > 0.008856 ? Math.pow(yy, 1 / 3) : 7.787 * yy + 16 / 116;
  const fz = zz > 0.008856 ? Math.pow(zz, 1 / 3) : 7.787 * zz + 16 / 116;

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * Convert an sRGB value to CIE LAB.
 */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const [x, y, z] = rgbToXyz(r, g, b);
  return xyzToLab(x, y, z);
}

/**
 * Convert CIE LAB to CIE XYZ.
 */
export function labToXyz(l: number, a: number, b: number): [number, number, number] {
  const y = (l + 16) / 116;
  const x = a / 500 + y;
  const z = y - b / 200;

  const xx = x > 0.206897 ? Math.pow(x, 3) : (x - 16 / 116) / 7.787;
  const yy = y > 0.206897 ? Math.pow(y, 3) : (y - 16 / 116) / 7.787;
  const zz = z > 0.206897 ? Math.pow(z, 3) : (z - 16 / 116) / 7.787;

  return [xx * 95.047, yy * 100.0, zz * 108.883];
}

/**
 * Convert CIE LAB to sRGB.
 */
export function labToRgb(l: number, a: number, b: number): [number, number, number] {
  const [x, y, z] = labToXyz(l, a, b);

  let rr = x / 100;
  let gg = y / 100;
  let bb = z / 100;

  rr = rr > 0.0031308 ? 1.055 * Math.pow(rr, 1 / 2.4) - 0.055 : 12.92 * rr;
  gg = gg > 0.0031308 ? 1.055 * Math.pow(gg, 1 / 2.4) - 0.055 : 12.92 * gg;
  bb = bb > 0.0031308 ? 1.055 * Math.pow(bb, 1 / 2.4) - 0.055 : 12.92 * bb;

  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  return [clamp(rr * 255), clamp(gg * 255), clamp(bb * 255)];
}

/**
 * The distance between two colours, in LAB space.
 *
 * This is what the reference uses: the difference between the colours as
 * the eye sees them, rather than the difference between the numbers.
 */
export function deltaE(
  lab1: readonly [number, number, number],
  lab2: readonly [number, number, number],
): number {
  const dl = lab1[0] - lab2[0];
  const da = lab1[1] - lab2[1];
  const db = lab1[2] - lab2[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

/**
 * Make the picture brighter or darker.
 */
export function applyExposure(rgb: Buffer, exposure: number): void {
  if (exposure === 1.0) return;

  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = Math.min(255, Math.round(rgb[i]! * exposure));
    rgb[i + 1] = Math.min(255, Math.round(rgb[i + 1]! * exposure));
    rgb[i + 2] = Math.min(255, Math.round(rgb[i + 2]! * exposure));
  }
}

/**
 * Raise or lower the contrast.
 */
export function applyContrast(rgb: Buffer, contrast: number): void {
  if (contrast === 1.0) return;

  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = Math.max(0, Math.min(255, Math.round((rgb[i]! - 128) * contrast + 128)));
    rgb[i + 1] = Math.max(0, Math.min(255, Math.round((rgb[i + 1]! - 128) * contrast + 128)));
    rgb[i + 2] = Math.max(0, Math.min(255, Math.round((rgb[i + 2]! - 128) * contrast + 128)));
  }
}

/**
 * Make the picture more or less colourful.
 *
 * The hue is left alone and only the saturation is changed, so that a
 * picture keeps the colours it has.
 */
export function applySaturation(rgb: Buffer, saturation: number): void {
  if (saturation === 1.0) return;

  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i]!;
    const g = rgb[i + 1]!;
    const b = rgb[i + 2]!;

    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const l = (max + min) / 2;

    if (max === min) continue; // Already grey.

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    let h: number;
    if (max === r / 255) {
      h = ((g / 255 - b / 255) / d + (g < b ? 6 : 0)) / 6;
    } else if (max === g / 255) {
      h = ((b / 255 - r / 255) / d + 2) / 6;
    } else {
      h = ((r / 255 - g / 255) / d + 4) / 6;
    }

    const newS = Math.max(0, Math.min(1, s * saturation));
    const c = (1 - Math.abs(2 * l - 1)) * newS;
    const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
    const m = l - c / 2;

    let rp: number;
    let gp: number;
    let bp: number;
    const sector = Math.floor(h * 6);

    if (sector === 0) {
      rp = c;
      gp = x;
      bp = 0;
    } else if (sector === 1) {
      rp = x;
      gp = c;
      bp = 0;
    } else if (sector === 2) {
      rp = 0;
      gp = c;
      bp = x;
    } else if (sector === 3) {
      rp = 0;
      gp = x;
      bp = c;
    } else if (sector === 4) {
      rp = x;
      gp = 0;
      bp = c;
    } else {
      rp = c;
      gp = 0;
      bp = x;
    }

    rgb[i] = Math.round((rp + m) * 255);
    rgb[i + 1] = Math.round((gp + m) * 255);
    rgb[i + 2] = Math.round((bp + m) * 255);
  }
}

/**
 * Bend the tones with an S-curve.
 *
 * The curve is steeper in the middle and flatter at the ends, so that the
 * shadows and the highlights are held back and the middle of the range
 * comes forward. The shadows can be lifted and the highlights brought
 * down, which is what keeps a bright picture from turning into a white
 * patch on the panel.
 */
export function applyScurveTonemap(
  rgb: Buffer,
  strength: number,
  shadowBoost: number,
  highlightCompress: number,
  midpoint: number,
): void {
  if (strength === 0) return;

  for (let i = 0; i < rgb.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const normalized = rgb[i + c]! / 255.0;
      let result: number;

      if (normalized <= midpoint) {
        const shadowVal = normalized / midpoint;
        result = Math.pow(shadowVal, 1.0 - strength * shadowBoost) * midpoint;
      } else {
        const highlightVal = (normalized - midpoint) / (1.0 - midpoint);
        result =
          midpoint +
          Math.pow(highlightVal, 1.0 + strength * highlightCompress) * (1.0 - midpoint);
      }

      rgb[i + c] = Math.max(0, Math.min(255, Math.round(result * 255)));
    }
  }
}

/**
 * Squeeze the picture's range onto the panel's own black and white.
 *
 * The panel's real black is above zero and its white is below 255, so an
 * untouched picture looks washed out.
 *
 * The range is moved in LAB space, where the lightness is the same measure
 * the eye uses, so the picture keeps its contrast and its colours.
 *
 * @param rgb    The picture, changed in place.
 * @param blackY The panel's black point, as a lightness from 0 to 100.
 * @param whiteY The panel's white point, as a lightness from 0 to 100.
 */
export function compressRange(
  rgb: Buffer,
  blackY: number,
  whiteY: number,
): void {
  for (let i = 0; i < rgb.length; i += 3) {
    const [l, a, bLab] = rgbToLab(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!);
    const compressedL = blackY + (l / 100) * (whiteY - blackY);
    const [newR, newG, newB] = labToRgb(compressedL, a, bLab);

    rgb[i] = newR;
    rgb[i + 1] = newG;
    rgb[i + 2] = newB;
  }
}

/**
 * The panel's black and white points, as lightnesses from 0 to 100.
 *
 * The panel's black is above zero and its white is below 255, so they are
 * measured rather than assumed.
 */
export function panelEndpoints(
  black: readonly [number, number, number],
  white: readonly [number, number, number],
): { blackY: number; whiteY: number } {
  const [blackL] = rgbToLab(black[0], black[1], black[2]);
  const [whiteL] = rgbToLab(white[0], white[1], white[2]);
  return { blackY: blackL, whiteY: whiteL };
}

/**
 * Make the picture brighter or darker, more or less colourful, and bend
 * its tones.
 *
 * This is the whole of the preparation, in the reference's order.
 */
export function toneMap(rgb: Buffer, params: ToneParams): void {
  if (params.exposure !== 1.0) {
    applyExposure(rgb, params.exposure);
  }

  if (params.saturation !== 1.0) {
    applySaturation(rgb, params.saturation);
  }

  if (params.toneMode === "contrast") {
    if (params.contrast !== 1.0) {
      applyContrast(rgb, params.contrast);
    }
  } else {
    applyScurveTonemap(
      rgb,
      params.strength,
      params.shadowBoost,
      params.highlightCompress,
      params.midpoint,
    );
  }
}

/**
 * Convert a value from sRGB to linear light.
 */
export function linearize(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * Convert a value from linear light back to sRGB.
 */
export function delinearize(value: number): number {
  const v = value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, v)) * 255);
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}
