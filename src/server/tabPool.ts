import type { GeminiDriver } from "../driver/GeminiDriver.js";
import { continuationOf, type ChatMessage } from "./protocol.js";

export interface PooledTab {
  driver: GeminiDriver;
  /** What this tab's thread holds, as the client will send it back. */
  history: ChatMessage[];
  /** Tool set the thread was primed with ("" for none). */
  toolsKey: string;
  /** Model alias last selected in this tab, to skip re-selecting it. */
  model?: string;
  busy: boolean;
}

export interface Lease {
  tab: PooledTab;
  /** Messages to send into the existing thread, or undefined for a fresh one. */
  continuation?: ChatMessage[];
}

/** Every tab is busy and the queue is at its limit: answered 429 at once. */
export class QueueFullError extends Error {}
/** Waited the whole queue timeout without a tab: answered 503. */
export class QueueTimeoutError extends Error {}
/** The client went away while queued. */
export class QueueAbortedError extends Error {}

export interface AcquireOptions {
  /** Aborts the wait (the client disconnected). */
  signal?: AbortSignal;
  /** Most requests allowed to wait at once (default 8). */
  maxQueue?: number;
  /** How long one request may wait, in ms (default 120 s). */
  timeoutMs?: number;
}

interface Waiter {
  give: (tab: PooledTab) => void;
}

/**
 * A fixed set of Gemini tabs shared by API requests.
 *
 * One request per tab at a time — a tab is one thread, and two prompts typed
 * into it at once would interleave. Requests beyond the pool size wait.
 *
 * The first tab is the one the server attached with; the rest are opened on
 * demand, so a server that only ever sees one request at a time costs one tab.
 */
export class TabPool {
  private readonly tabs: PooledTab[] = [];
  /** Oldest first: a freed tab goes straight to the head of the queue. */
  private readonly waiters: Waiter[] = [];
  private spawning = 0;

  constructor(
    private readonly first: GeminiDriver,
    private readonly size: number,
    private readonly log: (msg: string) => void = () => {}
  ) {
    this.tabs.push({ driver: first, history: [], toolsKey: "", busy: false });
  }

  get stats() {
    return { tabs: this.tabs.length, busy: this.tabs.filter((t) => t.busy).length, waiting: this.waiters.length };
  }

  /** The continuation a given tab offers this conversation, if any. */
  private leaseFor(tab: PooledTab, messages: ChatMessage[], toolsKey: string): Lease {
    if (tab.toolsKey === toolsKey) {
      const continuation = continuationOf(tab.history, messages);
      if (continuation) return { tab, continuation };
    }
    return { tab };
  }

  async acquire(messages: ChatMessage[], toolsKey: string, opts: AcquireOptions = {}): Promise<Lease> {
    if (opts.signal?.aborted) throw new QueueAbortedError("the client went away");
    // Others are already waiting: join the back of the queue rather than
    // jump it, so requests are served in arrival order.
    if (!this.waiters.length) {
      const now = await this.tryNow(messages, toolsKey);
      if (now) return now;
    }
    const maxQueue = opts.maxQueue ?? 8;
    if (this.waiters.length >= maxQueue) {
      throw new QueueFullError(`all ${this.tabs.length} tab(s) are busy and ${this.waiters.length} request(s) are already waiting`);
    }
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const tab = await new Promise<PooledTab>((resolve, reject) => {
      let settled = false;
      const waiter: Waiter = {
        give: (t) => {
          if (settled) {
            // Left in the same instant it was handed a tab: pass it on.
            this.release(t);
            return;
          }
          settled = true;
          cleanup();
          resolve(t);
        },
      };
      const leave = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(err);
      };
      const timer = setTimeout(() => leave(new QueueTimeoutError(`no tab became free within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      const onAbort = () => leave(new QueueAbortedError("the client went away while queued"));
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      this.waiters.push(waiter);
    });
    return this.leaseFor(tab, messages, toolsKey);
  }

  /** An idle (or new) tab right now, or undefined. */
  private async tryNow(messages: ChatMessage[], toolsKey: string): Promise<Lease | undefined> {
    {
      // Best: an idle tab whose thread IS the start of this conversation, so
      // only the new turn needs sending — how chat clients keep a thread going.
      for (const tab of this.tabs) {
        if (tab.busy || tab.toolsKey !== toolsKey) continue;
        const continuation = continuationOf(tab.history, messages);
        if (continuation) {
          tab.busy = true;
          return { tab, continuation };
        }
      }

      // Next: any idle tab, preferring one with no thread worth keeping.
      const idle = this.tabs.filter((t) => !t.busy).sort((a, b) => a.history.length - b.history.length)[0];
      if (idle) {
        idle.busy = true;
        return { tab: idle };
      }

      // Next: grow the pool.
      if (this.tabs.length + this.spawning < this.size) {
        this.spawning++;
        try {
          const n = this.tabs.length + 1;
          this.log(`opening API tab ${n}/${this.size}`);
          const driver = await this.first.spawnTab(`api ${n}`);
          const tab: PooledTab = { driver, history: [], toolsKey: "", busy: true };
          this.tabs.push(tab);
          return { tab };
        } finally {
          this.spawning--;
        }
      }

      return undefined;
    }
  }

  /** Frees a tab: straight to the oldest waiter if there is one (it stays busy), else idle. */
  release(tab: PooledTab): void {
    const next = this.waiters.shift();
    if (next) {
      tab.busy = true;
      next.give(tab);
    } else {
      tab.busy = false;
    }
  }

  /** Forgets a tab's thread, e.g. after a failed request left it in an unknown state. */
  reset(tab: PooledTab): void {
    tab.history = [];
    tab.toolsKey = "";
  }

  async close(): Promise<void> {
    // The first tab belongs to the attach; spawned ones are ours to close.
    for (const tab of this.tabs.slice(1)) await tab.driver.close().catch(() => undefined);
  }
}
