import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { appendDiagnosticRecord, ContextObserver, createDiagnosticWorker, resolveAssistantEntryIdFromFile, type DiagnosticJob } from "../src/runtime-diagnostics.js";
import { textSha256, type DiagnosticRecord, type HumanizerResult } from "../src/diagnostics.js";

const clean: HumanizerResult = { status: "ok", errors: 0, warnings: 0, score: 0, verdict: "clean", findings: [] };

function job(text: string): DiagnosticJob {
  return {
    text,
    timestamp: 100,
    provider: "openai",
    model: "test-model",
    sessionId: "session-1",
    work: { toolCalls: 6, toolResults: 5, toolResultChars: 12000, elapsedMs: 500 },
    sessionFile: "/session.jsonl",
  };
}

describe("runtime diagnostic worker", () => {
  test("stores a versioned record without the source text", async () => {
    const records: DiagnosticRecord[] = [];
    let now = 1000;
    const worker = createDiagnosticWorker({
      diagnosticsPath: "/unused",
      humanizerPath: "/unused",
      humanizerTimeoutMs: 10,
      lint: async () => ({ ...clean, findings: [{ kind: "WARN", line: 1, rule: "test", excerpt: "PRIVATE_TEST_SENTINEL" }], output: "PRIVATE_TEST_SENTINEL" }),
      appendRecord: async (_path, record) => { records.push(record); },
      now: () => now++,
      resolveEntryId: async () => "entry-1",
    });
    await worker(job("Результат проверки сохранён. Этот ответ достаточно длинный и написан нормальным русским техническим языком без лишнего отчёта о процессе."), new AbortController().signal);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      schema: "pi-russian-style-diagnostic/v2",
      context: null,
      stop_reason: null,
      entry_id: "entry-1",
      session_id: "session-1",
      decision: "clean",
      preceding_work: { tool_calls: 6, tool_results: 5, tool_result_chars: 12000, elapsed_ms: 500 },
    });
    expect(JSON.stringify(records[0])).not.toContain("Результат проверки");
    expect(JSON.stringify(records[0])).not.toContain("PRIVATE_TEST_SENTINEL");
  });

  test("appends private newline-delimited records", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-records-"));
    const path = join(root, "nested", "diagnostics.jsonl");
    const records: DiagnosticRecord[] = [];
    const worker = createDiagnosticWorker({
      diagnosticsPath: path,
      humanizerPath: "/unused",
      humanizerTimeoutMs: 10,
      lint: async () => clean,
      appendRecord: appendDiagnosticRecord,
      now: Date.now,
      resolveEntryId: async () => "entry-1",
    });
    await worker(job("Результат сохранён. Это достаточно длинный русский технический ответ для проверки локальной диагностической записи без исходного текста."), new AbortController().signal);
    const stored = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    records.push(...stored);
    expect(records).toHaveLength(1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "nested"))).mode & 0o777).toBe(0o700);
  });

  test("resolves entry ID by timestamp, provider, model and text hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-session-"));
    const path = join(root, "session.jsonl");
    const text = "Русский итоговый ответ";
    const lines = [
      { type: "session", version: 3, id: "session-1", timestamp: new Date().toISOString(), cwd: root },
      { type: "message", id: "wrong-provider", message: { role: "assistant", timestamp: 100, provider: "other", model: "test-model", content: [{ type: "text", text }] } },
      { type: "message", id: "answer-1", message: { role: "assistant", timestamp: 100, provider: "openai", model: "test-model", content: [{ type: "text", text }] } },
      { type: "custom", customType: "large-tail", data: "x".repeat(300_000) },
    ];
    await Bun.write(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const identity = { timestamp: 100, provider: "openai", model: "test-model", textHash: textSha256(text) };
    expect(await resolveAssistantEntryIdFromFile(path, identity)).toBe("answer-1");
    expect(await resolveAssistantEntryIdFromFile(path, { ...identity, provider: "missing" })).toBeNull();
  });

  test("does not write or notify after cancellation", async () => {
    const controller = new AbortController();
    let writes = 0;
    let notifications = 0;
    const worker = createDiagnosticWorker({
      diagnosticsPath: "/unused",
      humanizerPath: "/unused",
      humanizerTimeoutMs: 10,
      lint: async () => { controller.abort(); return clean; },
      appendRecord: async () => { writes++; },
      now: Date.now,
      resolveEntryId: async () => "entry-1",
    });
    await worker({ ...job("Реализовал runtime pipeline для production review. ".repeat(100)), notify: () => { notifications++; } }, controller.signal);
    expect(writes).toBe(0);
    expect(notifications).toBe(0);
  });
});

test("cancellation during entry resolution prevents storage", async () => {
  const controller = new AbortController();
  let writes = 0;
  const worker = createDiagnosticWorker({
    diagnosticsPath: "/unused", humanizerPath: "/unused", humanizerTimeoutMs: 10,
    lint: async () => clean, now: Date.now,
    resolveEntryId: async () => { controller.abort(); return "entry"; },
    appendRecord: async () => { writes++; },
  });
  await worker(job("Русский ответ"), controller.signal);
  expect(writes).toBe(0);
});

describe("context observation", () => {
  const ctx = () => ({
    model: { provider: "openai", id: "test-model" }, thinkingLevel: "medium",
    getContextUsage: () => ({ tokens: 250, contextWindow: 1000, percent: 25 }),
    getSystemPrompt: () => "Секретные правила проекта",
  } as any);

  test("captures detached estimates and only hashes the Pi prompt", () => {
    const observer = new ContextObserver();
    const context = ctx();
    observer.observe(context);
    const early = observer.snapshot("openai", "test-model")!;
    expect(early).toMatchObject({ context_tokens: 250, context_percent: 25, candidate_index: 1, observed_compactions: 0 });
    expect(early.pi_system_prompt_sha256).toBe(textSha256(context.getSystemPrompt()));
    expect(JSON.stringify(early)).not.toContain("Секретные");
    context.getContextUsage = () => ({ tokens: 750, contextWindow: 1000 });
    observer.observe(context);
    const late = observer.snapshot("openai", "test-model")!;
    expect(late.segment_id).toBe(early.segment_id);
    expect(late.candidate_index).toBe(2);
    expect(late.context_percent).toBe(75);
    expect(early.context_percent).toBe(25);
    expect(observer.snapshot("other", "test-model")).toBeNull();
    observer.invalidate();
    expect(observer.snapshot("openai", "test-model")).toBeNull();
  });

  test("separates compaction, tree, reload and configuration boundaries", () => {
    const observer = new ContextObserver();
    const context = ctx();
    observer.observe(context);
    let previous = observer.snapshot("openai", "test-model")!;
    for (const reason of ["compaction", "tree", "observation_start"] as const) {
      observer.reset(reason);
      expect(observer.snapshot("openai", "test-model")).toBeNull();
      observer.observe(context);
      const current = observer.snapshot("openai", "test-model")!;
      expect(current.segment_id).not.toBe(previous.segment_id);
      expect(current.segment_reason).toBe(reason);
      expect(current.candidate_index).toBe(1);
      expect(current.observed_compactions).toBe(reason === "observation_start" ? 0 : 1);
      previous = current;
    }
    for (const change of [
      () => { context.getSystemPrompt = () => "Новые правила"; },
      () => { context.thinkingLevel = "high"; },
      () => { context.model = { provider: "openai", id: "other" }; },
      () => { context.getContextUsage = () => ({ tokens: 250, contextWindow: 2000 }); },
    ]) {
      change();
      observer.observe(context);
      const current = observer.snapshot("openai", context.model.id)!;
      expect(current.segment_id).not.toBe(previous.segment_id);
      expect(current.segment_reason).toBe("configuration");
      previous = current;
    }
  });

  test("unknown, invalid and failing usage never becomes zero filling", () => {
    for (const usage of [undefined, { tokens: null, contextWindow: 1000 }, { tokens: NaN, contextWindow: 0 }, { tokens: -1, contextWindow: Infinity }]) {
      const observer = new ContextObserver();
      const context = ctx();
      context.getContextUsage = () => usage;
      observer.observe(context);
      expect(observer.snapshot("openai", "test-model")).toMatchObject({ context_tokens: null, context_percent: null, usage_source: "unavailable" });
    }
    const observer = new ContextObserver();
    const context = ctx();
    context.getContextUsage = () => { throw new Error("unavailable"); };
    context.getSystemPrompt = () => { throw new Error("unavailable"); };
    observer.observe(context);
    expect(observer.snapshot("openai", "test-model")).toMatchObject({ context_tokens: null, pi_system_prompt_sha256: null });
  });
});
