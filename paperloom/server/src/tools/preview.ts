/**
 * Render a test image and write a preview PNG.
 *
 * This is a quick way to see what the dithered result looks like, without
 * a frame attached.
 *
 *     npx tsx src/tools/preview.ts [input.jpg] [output.png]
 */

import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import sharp from "sharp";

import { renderAsset, renderPreview } from "../image.js";

/**
 * A test pattern: colour bars, which show every palette colour and make
 * the dithering easy to judge.
 */
async function testPattern(): Promise<Buffer> {
  const width = 1200;
  const height = 1600;
  const bars: Array<[number, number, number]> = [
    [255, 255, 255],
    [255, 255, 0],
    [255, 0, 0],
    [0, 0, 0],
    [0, 0, 255],
    [0, 255, 0],
  ];

  const raw = Buffer.alloc(width * height * 3);
  const barWidth = width / bars.length;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = Math.min(bars.length - 1, Math.floor(x / barWidth));
      const colour = bars[index]!;

      // Add a horizontal gradient to the lower half so the dithering has
      // something to work with.
      const gradient = y > height / 2 ? Math.round((x / width) * 255) : 0;

      const i = (y * width + x) * 3;
      raw[i] = Math.min(255, colour[0] + (colour[0] === 0 ? gradient : 0));
      raw[i + 1] = Math.min(255, colour[1] + (colour[1] === 0 ? gradient : 0));
      raw[i + 2] = Math.min(255, colour[2] + (colour[2] === 0 ? gradient : 0));
    }
  }

  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3] ?? "preview.png";

  const source = inputPath
    ? await sharp(inputPath).toBuffer()
    : await testPattern();

  const { data, raw, indices } = await renderAsset(source);
  const preview = await renderPreview(indices);

  await writeFile(outputPath, preview);

  // Report what the dither produced, so the result can be judged without
  // opening the image.
  //
  // The indices are palette *positions*. The packed asset translates them
  // into the panel's colour codes, which skip the reserved code 4.
  const counts = new Map<number, number>();
  for (const index of indices) {
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }

  const names = ["black", "white", "yellow", "red", "blue", "green"];
  console.log(`Wrote ${outputPath}`);
  console.log(`  raw frame:   ${raw.length} bytes`);
  console.log(`  compressed:  ${data.length} bytes`);
  console.log("  colour mix:");
  for (const [position, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const percent = ((count / indices.length) * 100).toFixed(1);
    console.log(`    ${names[position]!.padEnd(9)} ${percent}%`);
  }

  // The packed asset must never contain the reserved code.
  const { unpackIndices } = await import("../panel.js");
  const packed = unpackIndices(raw);
  for (const code of packed) {
    if (code === 4) {
      console.log("\n  WARNING: the reserved colour code 4 is present in the asset.");
      break;
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
