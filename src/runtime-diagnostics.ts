import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RUSSIAN_STYLE_PROMPT } from "./prompt.js";
import { open, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  decideDiagnostic,
  DIAGNOSTIC_RULES_VERSION,
  runHumanizer,
  technicalSignals,
  textSha256,
  diagnosticHumanizerResult,
  type DiagnosticRecord,
  type ContextObservation,
  type HumanizerResult,
} from "./diagnostics.js";

export const DEFAULT_DIAGNOSTICS_PATH = resolve(homedir(), ".pi", "agent", "state", "russian-style-diagnostics.jsonl");
export const DEFAULT_HUMANIZER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills", "humanizer-ru", "scripts", "lint.py");
export const DEFAULT_HUMANIZER_TIMEOUT_MS = 1500;

export type WorkSnapshot = {
  toolCalls: number;
  toolResults: number;
  toolResultChars: number;
  elapsedMs: number;
};

/** Наблюдает только непрерывный участок: перезапуски и переходы не склеиваются. */
export class ContextObserver {
  private segmentId = randomUUID();
  private reason: ContextObservation["segment_reason"] = "observation_start";
  private compactions = 0;
  private index = 0;
  private signature: string | undefined;
  private provider: string | undefined;
  private model: string | undefined;
  private current: Omit<ContextObservation, "candidate_index"> | null = null;
  private readonly promptVersion = textSha256(RUSSIAN_STYLE_PROMPT);

  reset(reason: ContextObservation["segment_reason"]): void {
    this.segmentId = randomUUID();
    this.reason = reason;
    this.index = 0;
    this.signature = undefined;
    this.current = null;
    if (reason === "observation_start") this.compactions = 0;
    if (reason === "compaction") this.compactions++;
  }

  invalidate(): void { this.current = null; }

  /** Снимает оценку Pi перед вызовом, не читая историю и не меняя контекст. */
  observe(ctx: Pick<ExtensionContext, "getContextUsage" | "getSystemPrompt" | "model" | "thinkingLevel">): void {
    this.current = null;
    let usage: ReturnType<ExtensionContext["getContextUsage"]>;
    let promptHash: string | null = null;
    try { usage = ctx.getContextUsage(); } catch { /* На старом Pi оценка может быть недоступна. */ }
    try { promptHash = textSha256(ctx.getSystemPrompt()); } catch { /* Не подменяем неизвестную подсказку локальным блоком. */ }
    const tokens = typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= 0 ? usage.tokens : null;
    const window = typeof usage?.contextWindow === "number" && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : null;
    this.provider = ctx.model?.provider;
    this.model = ctx.model?.id;
    const thinking = ctx.thinkingLevel ?? null;
    const signature = JSON.stringify([this.provider, this.model, thinking, promptHash, window]);
    if (this.signature !== undefined && this.signature !== signature) this.reset("configuration");
    this.signature = signature;
    this.current = {
      segment_id: this.segmentId,
      segment_reason: this.reason,
      observed_compactions: this.compactions,
      prompt_version: this.promptVersion,
      pi_system_prompt_sha256: promptHash,
      thinking_level: thinking,
      context_tokens: tokens,
      context_window: window,
      context_percent: tokens !== null && window !== null ? 100 * tokens / window : null,
      usage_source: tokens !== null ? "pi_context_estimate_before_call" : "unavailable",
    };
  }

  /** Копирует метаданные в задание; очередь не обращается к изменяемому ctx. */
  snapshot(provider: string, model: string): ContextObservation | null {
    if (!this.current || provider !== this.provider || model !== this.model) return null;
    return { ...this.current, candidate_index: ++this.index };
  }
}

export type DiagnosticJob = {
  text: string;
  timestamp: number;
  provider: string;
  model: string;
  sessionId: string;
  work: WorkSnapshot;
  context?: ContextObservation | null;
  stopReason?: string;
  sessionFile?: string;
  notify?: (message: string) => void;
};

export type RuntimeDiagnosticDependencies = {
  diagnosticsPath: string;
  humanizerPath: string;
  humanizerTimeoutMs: number;
  lint: (text: string, options: { path: string; timeoutMs: number; signal?: AbortSignal }) => Promise<HumanizerResult>;
  appendRecord: (path: string, record: DiagnosticRecord) => Promise<void>;
  resolveEntryId: (sessionFile: string | undefined, identity: { timestamp: number; provider: string; model: string; textHash: string }) => Promise<string | null>;
  now: () => number;
};

export async function appendDiagnosticRecord(path: string, record: DiagnosticRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "a", 0o600);
  try {
    await file.write(`${JSON.stringify(record)}\n`);
  } finally {
    await file.close();
  }
}

async function resolveEntryId(job: DiagnosticJob, textHash: string, signal: AbortSignal, dependencies: RuntimeDiagnosticDependencies): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const entryId = await dependencies.resolveEntryId(job.sessionFile, {
      timestamp: job.timestamp, provider: job.provider, model: job.model, textHash,
    });
    if (entryId || signal.aborted) return entryId;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

export async function resolveAssistantEntryIdFromFile(
  sessionFile: string | undefined,
  identity: { timestamp: number; provider: string; model: string; textHash: string },
): Promise<string | null> {
  if (!sessionFile) return null;
  const file = await open(sessionFile, "r").catch(() => null);
  if (!file) return null;
  try {
    const matches = (line: string): string | null => {
      if (!line) return null;
      let entry: any;
      try { entry = JSON.parse(line); } catch { return null; }
      const message = entry?.message;
      if (entry?.type !== "message" || message?.role !== "assistant") return null;
      if (message.timestamp !== identity.timestamp || message.provider !== identity.provider || message.model !== identity.model) return null;
      const text = Array.isArray(message.content)
        ? message.content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n")
        : "";
      return textSha256(text) === identity.textHash ? entry.id ?? null : null;
    };
    const info = await file.stat();
    const chunkSize = 64 * 1024;
    let position = info.size;
    let carry = Buffer.alloc(0);
    while (position > 0) {
      const start = Math.max(0, position - chunkSize);
      const buffer = Buffer.alloc(position - start);
      await file.read(buffer, 0, buffer.length, start);
      const combined = Buffer.concat([buffer, carry]);
      const lines: Buffer[] = [];
      let segmentEnd = combined.length;
      for (let index = combined.length - 1; index >= 0; index--) {
        if (combined[index] !== 0x0a) continue;
        lines.push(combined.subarray(index + 1, segmentEnd));
        segmentEnd = index;
      }
      carry = combined.subarray(0, segmentEnd);
      for (const line of lines) {
        const entryId = matches(line.toString("utf8"));
        if (entryId) return entryId;
      }
      position = start;
    }
    return matches(carry.toString("utf8"));
  } finally {
    await file.close();
  }
}

export function createDiagnosticWorker(dependencies: RuntimeDiagnosticDependencies) {
  return async (job: DiagnosticJob, signal: AbortSignal): Promise<void> => {
    const startedAt = dependencies.now();
    const textHash = textSha256(job.text);
    const [humanizer, signals] = await Promise.all([
      dependencies.lint(job.text, {
        path: dependencies.humanizerPath,
        timeoutMs: dependencies.humanizerTimeoutMs,
        signal,
      }),
      Promise.resolve(technicalSignals(job.text)),
    ]);
    if (signal.aborted) return;
    const decision = decideDiagnostic(humanizer, signals);
    const record: DiagnosticRecord = {
      schema: "pi-russian-style-diagnostic/v2",
      context: job.context ?? null,
      stop_reason: job.stopReason ?? null,
      rules_version: DIAGNOSTIC_RULES_VERSION,
      recorded_at: new Date(dependencies.now()).toISOString(),
      session_id: job.sessionId,
      entry_id: await resolveEntryId(job, textHash, signal, dependencies),
      message_timestamp: job.timestamp,
      provider: job.provider,
      model: job.model,
      text_sha256: textHash,
      chars: job.text.length,
      preceding_work: {
        tool_calls: job.work.toolCalls,
        tool_results: job.work.toolResults,
        tool_result_chars: job.work.toolResultChars,
        elapsed_ms: job.work.elapsedMs,
      },
      humanizer: diagnosticHumanizerResult(humanizer),
      signals,
      decision,
      processing_ms: Math.max(0, dependencies.now() - startedAt),
    };
    if (signal.aborted) return;
    await dependencies.appendRecord(dependencies.diagnosticsPath, record);
    if (signal.aborted) return;
    if (decision === "notify") job.notify?.("russian-style: итоговый ответ стоит проверить · /ru-clean доступен вручную");
  };
}

export const defaultRuntimeDiagnosticDependencies: RuntimeDiagnosticDependencies = {
  diagnosticsPath: process.env.PI_RUSSIAN_STYLE_DIAGNOSTICS_PATH || DEFAULT_DIAGNOSTICS_PATH,
  humanizerPath: process.env.PI_RUSSIAN_STYLE_LINTER_PATH || DEFAULT_HUMANIZER_PATH,
  humanizerTimeoutMs: Number(process.env.PI_RUSSIAN_STYLE_LINTER_TIMEOUT_MS) || DEFAULT_HUMANIZER_TIMEOUT_MS,
  lint: runHumanizer,
  appendRecord: appendDiagnosticRecord,
  resolveEntryId: resolveAssistantEntryIdFromFile,
  now: Date.now,
};
