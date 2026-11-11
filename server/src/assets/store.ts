/**
 * Asset storage.
 *
 * Rendered assets are content-addressed by the SHA-256 of their bytes. The
 * database holds the metadata; the bytes live on disk under a sharded
 * directory so that a single directory never holds tens of thousands of
 * entries.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Db } from "../db/index.js";

export interface AssetRecord {
  readonly contentHash: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Filesystem-backed asset store.
 */
export class AssetStore {
  constructor(
    private readonly db: Db,
    private readonly root: string,
  ) {}

  /**
   * The on-disk path for an asset hash.
   *
   * Sharded as `ab/cd/abcdef...` to keep directory sizes reasonable.
   */
  pathFor(contentHash: string): string {
    const safe = contentHash.replace(/[^a-f0-9]/gi, "");
    return join(this.root, safe.slice(0, 2), safe.slice(2, 4), safe);
  }

  /**
   * Store an asset, writing it atomically.
   *
   * The bytes are written to a temporary file and renamed into place, so a
   * crash mid-write never leaves a truncated asset that a device would
   * download and fail to verify.
   */
  async put(contentHash: string, data: Buffer, width: number, height: number): Promise<AssetRecord> {
    const target = this.pathFor(contentHash);
    await mkdir(dirname(target), { recursive: true });

    const existing = await stat(target).catch(() => null);
    if (existing === null) {
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, data);
      await rename(temp, target);
    }

    this.db
      .prepare(
        `INSERT INTO assets (content_hash, byte_size, width, height)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(content_hash) DO UPDATE SET byte_size = excluded.byte_size`,
      )
      .run(contentHash, data.length, width, height);

    return { contentHash, byteSize: data.length, width, height };
  }

  /**
   * Read an asset's bytes.
   */
  async get(contentHash: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(contentHash));
    } catch {
      return null;
    }
  }

  /**
   * Create a read stream for an asset, for range requests and large files.
   */
  createReadStream(contentHash: string) {
    return createReadStream(this.pathFor(contentHash));
  }

  /**
   * Whether an asset exists both in the database and on disk.
   */
  async has(contentHash: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT 1 FROM assets WHERE content_hash = ?")
      .get(contentHash);
    if (!row) return false;
    const info = await stat(this.pathFor(contentHash)).catch(() => null);
    return info !== null;
  }

  /**
   * Delete an asset that is no longer referenced by any photo.
   *
   * Returns true if something was removed.
   */
  async remove(contentHash: string): Promise<boolean> {
    const referenced = this.db
      .prepare("SELECT 1 FROM photos WHERE content_hash = ? LIMIT 1")
      .get(contentHash);
    if (referenced) return false;

    await rm(this.pathFor(contentHash), { force: true });
    this.db.prepare("DELETE FROM assets WHERE content_hash = ?").run(contentHash);
    return true;
  }

  /**
   * Compute the content hash of some bytes.
   */
  static hash(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
  }
}
