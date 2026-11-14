/**
 * The Telegram poller.
 *
 * Rather than waiting for Telegram to push updates to the server, the
 * server asks Telegram for them. That way the server does not have to be
 * reachable from the public internet, which is what a frame on a home
 * network usually is not.
 *
 * The poll is a long poll: the request waits for an update to arrive
 * rather than returning straight away, so Telegram is not asked for
 * nothing over and over.
 *
 * The last update id collected is kept in memory, and is the offset sent
 * with the next request. Telegram then forgets the updates before it, so
 * the queue does not grow for ever.
 */

import type { TelegramUpdate } from "./client.js";

export interface TelegramPollerOptions {
  /** Collects the updates Telegram returns. */
  readonly fetchUpdates: (offset: number, timeoutSeconds: number) => Promise<TelegramUpdate[]>;
  /** Called for each update that arrives. */
  readonly onUpdate: (update: TelegramUpdate) => Promise<void>;
  /** How long to wait between polls, in milliseconds. */
  readonly intervalMs?: number;
  /** How long Telegram should hold the request open, in seconds. */
  readonly longPollSeconds?: number;
  /** Called when a poll fails. */
  readonly onError?: (error: unknown) => void;
}

export class TelegramPoller {
  /** The id of the last update collected. */
  private offset = 0;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  /** The work being done on the updates that have arrived. */
  private readonly inFlight = new Set<Promise<void>>();

  /** The poll that is under way, if there is one. */
  private inFlightPoll: Promise<void> = Promise.resolve();

  constructor(private readonly options: TelegramPollerOptions) {}

  /**
   * Start polling.
   */
  start(): void {
    if (this.timer) return;
    this.stopped = false;

    const interval = this.options.intervalMs ?? 3000;
    this.timer = setInterval(() => {
      void this.poll();
    }, interval);

    /* The poller should not be the reason the process stays alive. */
    this.timer.unref?.();

    /* Ask at once, so that the first picture does not wait a whole
     * interval for the poll that follows the start. */
    void this.poll();
  }

  /**
   * Stop polling and wait for the poll in hand to finish.
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
   * The offset the next poll will use.
   *
   * Exposed so that the tests can check that updates are not seen twice.
   */
  get lastOffset(): number {
    return this.offset;
  }

  /**
   * Wait for the updates in hand to be dealt with.
   *
   * A poll hands each update to the caller and moves on, so the work is
   * still going when the poll returns. This waits for it to finish.
   */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /**
   * Ask Telegram for the updates that have arrived.
   *
   * Exposed so that a caller can poll at once rather than waiting for
   * the next tick, and so that the tests can drive it without a timer.
   */
  async poll(): Promise<void> {
    /* A poll is already under way. It will pick up whatever is
     * waiting, so this waits for it rather than starting a second one
     * alongside it. */
    if (this.running) {
      await this.inFlightPoll;
      return;
    }

    this.running = true;
    const work = this.pollOnce();
    this.inFlightPoll = work;
    try {
      await work;
    } finally {
      this.inFlightPoll = Promise.resolve();
      this.running = false;
    }
  }

  /**
   * Ask Telegram for the updates that have arrived.
   */
  private async pollOnce(): Promise<void> {
    try {
      const timeout = this.options.longPollSeconds ?? 30;
      const updates = await this.options.fetchUpdates(this.offset, timeout);

      for (const update of updates) {
        if (this.stopped) break;

        /* The offset is moved on before the update is handled, so that a
         * failure while handling it does not make it arrive again for
         * ever. */
        this.offset = update.update_id + 1;

        try {
          const work = this.options.onUpdate(update);
          this.inFlight.add(work);
          void work.finally(() => this.inFlight.delete(work));
          await work;
        } catch (error) {
          this.options.onError?.(error);
        }
      }
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
