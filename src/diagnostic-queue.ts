export type QueueStats = {
  accepted: number;
  completed: number;
  dropped: number;
  failed: number;
  pending: number;
  active: boolean;
};

export class BoundedDiagnosticQueue<T> {
  private pending: Array<{ key: string; value: T }> = [];
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private controller: AbortController | undefined;
  private running = false;
  private closed = false;
  private accepted = 0;
  private completed = 0;
  private dropped = 0;
  private failed = 0;

  constructor(
    private readonly worker: (value: T, signal: AbortSignal) => Promise<void>,
    private readonly maxPending = 8,
    private readonly maxSeen = 1024,
  ) {}

  enqueue(key: string, value: T): boolean {
    if (this.closed || this.seen.has(key)) return false;
    if (this.pending.length >= this.maxPending) {
      this.dropped++;
      return false;
    }
    this.pending.push({ key, value });
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > this.maxSeen) {
      const oldest = this.seenOrder.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.accepted++;
    this.start();
    return true;
  }

  close(): void {
    this.closed = true;
    this.pending = [];
    this.seen.clear();
    this.seenOrder = [];
    this.controller?.abort();
  }

  stats(): QueueStats {
    return {
      accepted: this.accepted,
      completed: this.completed,
      dropped: this.dropped,
      failed: this.failed,
      pending: this.pending.length,
      active: this.running,
    };
  }

  async drain(): Promise<void> {
    while (this.running || this.pending.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    queueMicrotask(() => { void this.pump(); });
  }

  private async pump(): Promise<void> {
    try {
      while (!this.closed) {
        const item = this.pending.shift();
        if (!item) break;
        this.controller = new AbortController();
        try {
          await this.worker(item.value, this.controller.signal);
          this.completed++;
        } catch {
          this.failed++;
        } finally {
          this.controller = undefined;
        }
      }
    } finally {
      this.running = false;
      if (!this.closed && this.pending.length > 0) this.start();
    }
  }
}
