/**
 * The photo queue.
 *
 * Rendering a photo takes a moment, and a chat can send several at once.
 * Rather than rendering inside the request that received the picture, the
 * picture is queued and rendered in the background.
 *
 * The queue is a table rather than a list held in memory, so a picture
 * survives a restart of the server. A job is claimed by marking it
 * "processing" in a transaction, so that a server with more than one
 * worker cannot pick up the same job twice.
 */

import type { Db } from "../db/index.js";
import { AssetStore } from "../assets/store.js";
import { GalleryPhotoService } from "../gallery/photos.js";

export type PhotoJobStatus = "pending" | "processing" | "done" | "failed";

export interface PhotoJob {
  readonly id: number;
  readonly gallery_id: number;
  readonly source_hash: string;
  readonly filename: string;
  readonly origin: string;
  readonly status: PhotoJobStatus;
  readonly error: string | null;
  readonly photo_id: number | null;
  readonly attempts: number;
}

/** How many times a job is tried before it is given up on. */
const MAX_ATTEMPTS = 3;

export interface PhotoQueueOptions {
  readonly db: Db;
  readonly assets: AssetStore;
  readonly photos: GalleryPhotoService;
}

export class PhotoQueue {
  constructor(private readonly options: PhotoQueueOptions) {}

  /**
   * Put a picture in the queue.
   *
   * The original is kept straight away, so that the bytes survive even
   * if the server stops before the job is picked up. The job then only
   * needs to carry the hash of the original, not the original itself.
   */
  async enqueue(
    galleryId: number,
    filename: string,
    source: Buffer,
    origin: string,
  ): Promise<number> {
    const { db, assets } = this.options;

    const sourceHash = AssetStore.hash(source);
    await assets.putSource(sourceHash, source);

    const result = db
      .prepare(
        `INSERT INTO photo_jobs (gallery_id, source_hash, filename, origin, status)
         VALUES (?, ?, ?, ?, 'pending')`,
      )
      .run(galleryId, sourceHash, filename, origin);

    return Number(result.lastInsertRowid);
  }

  /**
   * The jobs waiting to be done, oldest first.
   */
  pending(limit = 50): PhotoJob[] {
    const rows = this.options.db
      .prepare(
        `SELECT id, gallery_id, source_hash, filename, origin, status, error, photo_id, attempts
         FROM photo_jobs WHERE status = 'pending'
         ORDER BY id LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      gallery_id: number;
      source_hash: string;
      filename: string;
      origin: string;
      status: PhotoJobStatus;
      error: string | null;
      photo_id: number | null;
      attempts: number;
    }>;
    return rows;
  }

  /**
   * Take a job and mark it as being worked on.
   *
   * The claim and the update happen in one transaction, so two workers
   * cannot both be given the same job.
   */
  claim(jobId: number): PhotoJob | undefined {
    const { db } = this.options;

    const claim = db.transaction((id: number): PhotoJob | undefined => {
      const row = db
        .prepare(
          `SELECT id, gallery_id, source_hash, filename, origin, status, error, photo_id, attempts
           FROM photo_jobs WHERE id = ? AND status = 'pending'`,
        )
        .get(id) as
        | {
            id: number;
            gallery_id: number;
            source_hash: string;
            filename: string;
            origin: string;
            status: PhotoJobStatus;
            error: string | null;
            photo_id: number | null;
            attempts: number;
          }
        | undefined;
      if (!row) return undefined;

      db.prepare(
        `UPDATE photo_jobs
         SET status = 'processing', attempts = attempts + 1, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(id);

      return { ...row, status: "processing", attempts: row.attempts + 1 };
    });

    return claim(jobId);
  }

  /**
   * Finish a job that was rendered successfully.
   */
  complete(jobId: number, photoId: number): void {
    this.options.db
      .prepare(
        `UPDATE photo_jobs
         SET status = 'done', photo_id = ?, error = NULL, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(photoId, jobId);
  }

  /**
   * Record that a job failed.
   *
   * A job that has not used up its attempts goes back in the queue to be
   * tried again; one that has is left failed, so that it does not spin
   * forever on a picture that cannot be rendered.
   */
  fail(jobId: number, error: string, attempts: number): "retry" | "failed" {
    const { db } = this.options;

    if (attempts >= MAX_ATTEMPTS) {
      db.prepare(
        `UPDATE photo_jobs
         SET status = 'failed', error = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(error.slice(0, 500), jobId);
      return "failed";
    }

    db.prepare(
      `UPDATE photo_jobs
       SET status = 'pending', error = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(error.slice(0, 500), jobId);
    return "retry";
  }

  /**
   * The number of jobs waiting, for the status endpoint.
   */
  countPending(): number {
    const row = this.options.db
      .prepare("SELECT COUNT(*) AS n FROM photo_jobs WHERE status = 'pending'")
      .get() as { n: number };
    return row.n;
  }
}

/**
 * The background worker.
 *
 * It wakes up, renders whatever is waiting, and goes back to sleep. The
 * loop is driven by a timer rather than by a blocking wait, so that the
 * server can shut down promptly.
 */
export interface PhotoWorkerOptions {
  readonly queue: PhotoQueue;
  readonly assets: AssetStore;
  readonly photos: GalleryPhotoService;
  /** How long to wait between looks for work, in milliseconds. */
  readonly intervalMs?: number;
  /** Called when a job cannot be rendered. */
  readonly onError?: (job: PhotoJob, error: unknown) => void;
  /** Called when a job has been rendered and filed. */
  readonly onComplete?: (job: PhotoJob, photoId: number) => void;
}

export class PhotoWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(private readonly options: PhotoWorkerOptions) {}

  /**
   * Start the worker.
   */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const interval = this.options.intervalMs ?? 1000;
    this.timer = setInterval(() => {
      void this.drain();
    }, interval);
    /* The worker should not be the reason the process stays alive. */
    this.timer.unref?.();
  }

  /**
   * Stop the worker and wait for the work in hand to finish.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /**
   * Render everything that is waiting.
   *
   * Exposed so that a caller can drain the queue at once rather than
   * waiting for the next tick, and so that the tests can drive it
   * without a timer.
   */
  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      for (const job of this.options.queue.pending()) {
        if (this.stopped) break;

        const claimed = this.options.queue.claim(job.id);
        if (!claimed) continue;

        try {
          const source = await this.options.assets.getSource(claimed.source_hash);
          if (!source) {
            throw new Error("the original is no longer available");
          }

          /* A picture that came from a chat is pinned to the next check-in of
           * the frames showing its gallery, so that it is shown on the next
           * wake rather than waiting for its turn in the rotation. */
          const added = await this.options.photos.addPhoto(
            claimed.gallery_id,
            claimed.filename,
            source,
            { pin: claimed.origin === "telegram" },
          );

          this.options.queue.complete(claimed.id, added.id);
          this.options.onComplete?.(claimed, added.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          /* A job that has used up its attempts is left failed rather than
           * put back in the queue, so that a picture which cannot be
           * rendered does not spin forever. */
          this.options.queue.fail(claimed.id, message, claimed.attempts);
          this.options.onError?.(claimed, error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
