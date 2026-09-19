import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";

export const DIAGNOSTIC_RULES_VERSION = "2026-09-03-v2";

export type SignalSeverity = "mild" | "severe";
export type DiagnosticDecision = "clean" | "record" | "notify";

export type TechnicalSignal = {
  rule: string;
  severity: SignalSeverity;
  count: number;
  distinct?: number;
};

export type HumanizerResult = {
  status: "ok" | "timeout" | "error";
  errors: number;
  warnings: number;
  score: number;
  verdict: "clean" | "review" | "rewrite" | "unavailable";
  findings: Array<{ kind: "ERROR" | "WARN"; line: number; rule: string; excerpt: string }>;
  output?: string;
};

export type DiagnosticHumanizerResult = Omit<HumanizerResult, "findings" | "output"> & {
  findings: Array<{ kind: "ERROR" | "WARN"; line: number; rule: string }>;
};

export function diagnosticHumanizerResult(result: HumanizerResult): DiagnosticHumanizerResult {
  return {
    status: result.status,
    errors: result.errors,
    warnings: result.warnings,
    score: result.score,
    verdict: result.verdict,
    findings: result.findings.map(({ kind, line, rule }) => ({ kind, line, rule })),
  };
}

export type ContextObservation = {
  segment_id: string;
  segment_reason: "observation_start" | "compaction" | "tree" | "configuration";
  observed_compactions: number;
  candidate_index: number;
  prompt_version: string;
  pi_system_prompt_sha256: string | null;
  thinking_level: string | null;
  context_tokens: number | null;
  context_window: number | null;
  context_percent: number | null;
  usage_source: "pi_context_estimate_before_call" | "unavailable";
};

export type DiagnosticRecord = {
  schema: "pi-russian-style-diagnostic/v1" | "pi-russian-style-diagnostic/v2";
  context?: ContextObservation | null;
  stop_reason?: string | null;
  rules_version: string;
  recorded_at: string;
  session_id: string;
  entry_id: string | null;
  message_timestamp: number;
  provider: string;
  model: string;
  text_sha256: string;
  chars: number;
  preceding_work: {
    tool_calls: number;
    tool_results: number;
    tool_result_chars: number;
    elapsed_ms: number;
  };
  humanizer: DiagnosticHumanizerResult;
  signals: TechnicalSignal[];
  decision: DiagnosticDecision;
  processing_ms: number;
};

const CODE = /```[\s\S]*?```|`[^`\n]+`|https?:\/\/\S+/g;
const MIXED_SENTENCE = /(?=[^\n.!?]*[А-Яа-яЁё])(?=[^\n.!?]*\b[A-Za-z][A-Za-z-]{2,}\b)[^\n.!?]+/g;
const INTERNAL_TERM = /\b(?:runtime|scope|workflow|pipeline|fallback|guard|lease|review|final|input|output|read-only|production|live|canonical|provenance|evidence|repair|worker|agent-pull)\b/gi;
const STYLE_DEBT_TERM = /\b(?:admission|append-only|authority|best-effort|binding|body bytes|consolidation|declarative|definite failure|editorial|exact|finding|fingerprint|hard gates|host-owned|identity|identity line|ledger|lifecycle|manifest|materialization|narrative|orientation|posting|pre-editor|preview|private pending|proposal|provider requests|readback|renderer|revision|rollout|seal|semantic|validation|verdict)\b/gi;
const PROCESS_OPENING = /^(?:Готово|Сделал|Реализовал|Исправил|Обновил|Добавил|Проверил|Продолжил|Перепроверил|Разобрался|Завершил)(?:\s|[.:,]|$)/i;
const ARCHITECTURE_METAPHOR = /\b(?:контур\w*|пайплайн\w*|гейт\w*|сло[йяею]\w*|рамк\w*)\b/gi;

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function matchValues(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[0].toLowerCase());
}

export function assistantText(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((item): item is { type: "text"; text: string } => Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string"))
    .map((item) => item.text)
    .join("\n");
}

export function isRussianDiagnosticCandidate(message: {
  role?: string;
  stopReason?: string;
  content?: unknown;
}): boolean {
  if (message.role !== "assistant" || !["stop", "length"].includes(message.stopReason ?? "")) return false;
  const text = assistantText(message);
  if (text.length < 120) return false;
  const prose = text.replace(CODE, " ");
  const cyrillic = (prose.match(/[А-Яа-яЁё]/g) ?? []).length;
  const latin = (prose.match(/[A-Za-z]/g) ?? []).length;
  return cyrillic >= 20 && cyrillic * 4 >= latin;
}

export function technicalSignals(text: string): TechnicalSignal[] {
  const prose = text.replace(CODE, " ");
  const signals: TechnicalSignal[] = [];
  const mixed = countMatches(prose, MIXED_SENTENCE);
  if (mixed > 0) signals.push({ rule: "mixed_sentences", severity: mixed >= 3 ? "severe" : "mild", count: mixed });
  const internal = countMatches(prose, INTERNAL_TERM);
  if (internal > 0) signals.push({ rule: "internal_english", severity: internal >= 5 ? "severe" : "mild", count: internal });
  const styleDebt = matchValues(prose, STYLE_DEBT_TERM);
  if (styleDebt.length > 0) {
    const distinct = new Set(styleDebt).size;
    signals.push({
      rule: "style_debt_english",
      severity: styleDebt.length >= 10 && distinct >= 2 ? "severe" : "mild",
      count: styleDebt.length,
      distinct,
    });
  }
  const metaphors = countMatches(prose, ARCHITECTURE_METAPHOR);
  if (metaphors > 0) signals.push({ rule: "architecture_metaphors", severity: metaphors >= 5 ? "severe" : "mild", count: metaphors });
  if (PROCESS_OPENING.test(prose.trimStart())) signals.push({ rule: "process_opening", severity: text.length >= 1800 ? "severe" : "mild", count: 1 });
  if (text.length >= 6000) signals.push({ rule: "excessive_length", severity: text.length >= 12_000 ? "severe" : "mild", count: text.length });
  return signals;
}

export function decideDiagnostic(humanizer: HumanizerResult, signals: TechnicalSignal[]): DiagnosticDecision {
  if (humanizer.status !== "ok") return "record";
  const styleDebt = signals.find((signal) => signal.rule === "style_debt_english");
  if (styleDebt?.severity === "severe") return "notify";
  if (styleDebt) return "record";
  return "clean";
}

export function textSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function runHumanizer(
  text: string,
  options: { path: string; timeoutMs: number; signal?: AbortSignal; formal?: boolean },
): Promise<HumanizerResult> {
  const child = spawn("python3", [options.path, ...(options.formal ? ["--formal"] : [])], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const abort = () => child.kill("SIGKILL");
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs);
  child.stdin.end(text);
  try {
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    const summary = stdout.match(/итого:\s*(\d+) errors,\s*(\d+) warnings,\s*severity\s*(\d+)\s*->\s*(clean|review|rewrite)/);
    if (signal === "SIGKILL") return { status: "timeout", errors: 0, warnings: 0, score: 0, verdict: "unavailable", findings: [] };
    if (!summary) return { status: "error", errors: 0, warnings: 0, score: 0, verdict: "unavailable", findings: [], output: (stderr || stdout).slice(-1000) };
    const findings = stdout.split("\n").flatMap((line) => {
      const match = line.match(/^(ERROR|WARN) строка (\d+): \[([^\]]+)\] (.*)$/);
      return match ? [{ kind: match[1] as "ERROR" | "WARN", line: Number(match[2]), rule: match[3], excerpt: match[4] }] : [];
    });
    return {
      status: code === 0 || code === 1 ? "ok" : "error",
      errors: Number(summary[1]),
      warnings: Number(summary[2]),
      score: Number(summary[3]),
      verdict: summary[4] as "clean" | "review" | "rewrite",
      findings,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
