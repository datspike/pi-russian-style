import { performance } from "node:perf_hooks";
import { createRussianStyleExtension } from "../src/index.js";
import { BoundedDiagnosticQueue } from "../src/diagnostic-queue.js";
import { runHumanizer } from "../src/diagnostics.js";
import { DEFAULT_HUMANIZER_PATH } from "../src/runtime-diagnostics.js";

type Handler = (...args: any[]) => any;

type Sample = {
  iterations: number;
  average_us: number;
  p50_us: number;
  p95_us: number;
  p99_us: number;
  max_us: number;
};

function percentile(values: number[], ratio: number): number {
  return values[Math.min(values.length - 1, Math.floor(values.length * ratio))] ?? 0;
}

function measure(iterations: number, operation: (index: number) => void): Sample {
  const values: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    operation(index);
    values.push((performance.now() - started) * 1000);
  }
  values.sort((left, right) => left - right);
  return {
    iterations,
    average_us: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50_us: percentile(values, 0.50),
    p95_us: percentile(values, 0.95),
    p99_us: percentile(values, 0.99),
    max_us: values.at(-1) ?? 0,
  };
}

async function measureAsync(iterations: number, operation: (index: number) => Promise<void>): Promise<Sample> {
  const values: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    await operation(index);
    values.push((performance.now() - started) * 1000);
  }
  values.sort((left, right) => left - right);
  return {
    iterations,
    average_us: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50_us: percentile(values, 0.50),
    p95_us: percentile(values, 0.95),
    p99_us: percentile(values, 0.99),
    max_us: values.at(-1) ?? 0,
  };
}

const events = new Map<string, Handler>();
const addHandler = (name: string, handler: Handler) => {
  const previous = events.get(name);
  if (!previous) { events.set(name, handler); return; }
  events.set(name, (...args: any[]) => { previous(...args); return handler(...args); });
};
let activeTools = ["read", "edit"];
const pi = {
  on: addHandler,
  registerCommand: () => {},
  registerTool: () => {},
  getActiveTools: () => activeTools,
  setActiveTools: (next: string[]) => { activeTools = next; },
  appendEntry: () => {},
  sendMessage: () => {},
};
createRussianStyleExtension({
  diagnosticDependencies: {
    diagnosticsPath: "/unused",
    humanizerPath: "/unused",
    humanizerTimeoutMs: 10,
    lint: async () => ({ status: "ok", errors: 0, warnings: 0, score: 0, verdict: "clean", findings: [] }),
    appendRecord: async () => {},
    resolveEntryId: async () => null,
    now: Date.now,
  },
})(pi as any);

const ctx = {
  hasUI: false,
  model: { provider: "benchmark", id: "benchmark" },
  thinkingLevel: "medium",
  getContextUsage: () => ({ tokens: 180_000, contextWindow: 272_000 }),
  getSystemPrompt: () => "Русские технические правила",
  sessionManager: { getSessionId: () => "benchmark", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
};
const handler = events.get("message_end")!;
events.get("context")?.({ messages: [] }, ctx);
const shortText = "Результат готов. Этот русский технический ответ проверяет стоимость обработчика после завершения сообщения и не содержит лишних подробностей. ".repeat(2);
const longText = "Подробный русский технический результат с командами и идентификаторами runtime workflow. ".repeat(150);
const message = (text: string, timestamp: number) => ({
  message: {
    role: "assistant",
    stopReason: "stop",
    timestamp,
    provider: "benchmark",
    model: "benchmark",
    content: [{ type: "text", text }],
  },
});

measure(200, () => {});
measure(200, (index) => handler(message(shortText, index), ctx));

const heapBefore = process.memoryUsage().heapUsed;
const baseline = measure(5000, () => {});
const short = measure(5000, (index) => handler(message(shortText, 10_000 + index), ctx));
const long = measure(1000, (index) => handler(message(longText, 20_000 + index), ctx));
const heapAfter = process.memoryUsage().heapUsed;
events.get("session_shutdown")?.({}, ctx);

const humanizerProbe = await runHumanizer(shortText, { path: DEFAULT_HUMANIZER_PATH, timeoutMs: 1500 });
const backgroundShort = await measureAsync(5, async () => {
  await runHumanizer(shortText, { path: DEFAULT_HUMANIZER_PATH, timeoutMs: 1500 });
});
const backgroundLong = await measureAsync(5, async () => {
  await runHumanizer(longText, { path: DEFAULT_HUMANIZER_PATH, timeoutMs: 1500 });
});
let activeWorkers = 0;
let maximumWorkers = 0;
const loadQueue = new BoundedDiagnosticQueue(async () => {
  activeWorkers++;
  maximumWorkers = Math.max(maximumWorkers, activeWorkers);
  await Bun.sleep(1);
  activeWorkers--;
}, 8);
for (let index = 0; index < 100; index++) loadQueue.enqueue(String(index), index);
await loadQueue.drain();

console.log(JSON.stringify({
  schema: "pi-russian-style-message-end-benchmark/v1",
  generated_at: new Date().toISOString(),
  runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
  workload: { short_chars: shortText.length, long_chars: longText.length },
  critical_path: {
    scope: "synchronous message_end admission; overloaded calls may be dropped by the bounded queue",
    baseline,
    short,
    long,
  },
  background_processing: { humanizer_status: humanizerProbe.status, short: backgroundShort, long: backgroundLong },
  queue_load: { queue_limit: 8, submitted: 100, ...loadQueue.stats(), maximum_workers: maximumWorkers },
  heap_delta_bytes_before_worker: heapAfter - heapBefore,
  acceptance_budget: {
    p95_us: 2000,
    heap_delta_bytes: 10 * 1024 * 1024,
    result: short.p95_us < 2000
      && long.p95_us < 2000
      && heapAfter - heapBefore < 10 * 1024 * 1024
      && humanizerProbe.status === "ok"
      && maximumWorkers === 1
      && loadQueue.stats().dropped > 0
      ? "pass" : "fail",
  },
}, null, 2));
