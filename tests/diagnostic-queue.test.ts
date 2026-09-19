import { describe, expect, test } from "bun:test";
import { BoundedDiagnosticQueue } from "../src/diagnostic-queue.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("bounded diagnostic queue", () => {
  test("defers work beyond the caller and deduplicates pending jobs", async () => {
    const gate = deferred();
    let starts = 0;
    const queue = new BoundedDiagnosticQueue(async () => { starts++; await gate.promise; }, 2);
    expect(queue.enqueue("a", 1)).toBe(true);
    expect(starts).toBe(0);
    expect(queue.enqueue("a", 2)).toBe(false);
    await Promise.resolve();
    expect(starts).toBe(1);
    gate.resolve();
    await queue.drain();
    expect(queue.stats()).toMatchObject({ accepted: 1, completed: 1, dropped: 0, failed: 0, pending: 0, active: false });
  });

  test("keeps recent deduplication bounded after completion", async () => {
    const values: number[] = [];
    const queue = new BoundedDiagnosticQueue(async (value: number) => { values.push(value); }, 2, 2);
    queue.enqueue("a", 1);
    await queue.drain();
    expect(queue.enqueue("a", 2)).toBe(false);
    queue.enqueue("b", 3);
    queue.enqueue("c", 4);
    await queue.drain();
    expect(queue.enqueue("a", 5)).toBe(true);
    await queue.drain();
    expect(values).toEqual([1, 3, 4, 5]);
  });

  test("runs at most one worker under load", async () => {
    let active = 0;
    let maximum = 0;
    const queue = new BoundedDiagnosticQueue(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await Bun.sleep(1);
      active--;
    }, 32);
    for (let index = 0; index < 32; index++) queue.enqueue(String(index), index);
    await queue.drain();
    expect(maximum).toBe(1);
    expect(queue.stats().completed).toBe(32);
  });

  test("bounds the waiting queue and aborts active work on close", async () => {
    let aborted = false;
    const queue = new BoundedDiagnosticQueue(async (_value, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    }, 1);
    expect(queue.enqueue("a", 1)).toBe(true);
    await Promise.resolve();
    expect(queue.enqueue("b", 2)).toBe(true);
    expect(queue.enqueue("c", 3)).toBe(false);
    queue.close();
    await queue.drain();
    expect(aborted).toBe(true);
    expect(queue.stats().dropped).toBe(1);
  });
});
