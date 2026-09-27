import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyRussianStylePrompt,
} from "./prompt.js";
import { BoundedDiagnosticQueue } from "./diagnostic-queue.js";
import { assistantText, isRussianDiagnosticCandidate } from "./diagnostics.js";
import {
  createDiagnosticWorker,
  ContextObserver,
  defaultAgentDir,
  defaultRuntimeDiagnosticDependencies,
  type DiagnosticJob,
  type RuntimeDiagnosticDependencies,
} from "./runtime-diagnostics.js";
import { installHumanizer } from "./humanizer.js";

export type RussianStyleState = { version: 2; enabled: boolean; diagnosticsEnabled: boolean };
type LegacyRussianStyleState = { version: 1; enabled: boolean };
type StateAction = "on" | "off" | "toggle" | "diagnostics-on" | "diagnostics-off" | "diagnostics-toggle";
type LoadResult = { state: RussianStyleState; warning?: string };
type Dependencies = {
  statePath: string;
  readState: (path: string) => Promise<LoadResult>;
  mutateState: (path: string, action: StateAction) => Promise<RussianStyleState>;
  diagnosticDependencies: RuntimeDiagnosticDependencies;
  queueSize: number;
};
type DependencyOverrides = Partial<Omit<Dependencies, "diagnosticDependencies">> & {
  diagnosticDependencies?: Partial<RuntimeDiagnosticDependencies>;
};

export const DEFAULT_RUSSIAN_STYLE_STATE: RussianStyleState = { version: 2, enabled: true, diagnosticsEnabled: false };
export function defaultRussianStyleStatePath(): string { return resolve(defaultAgentDir(), "state", "russian-style.json"); }

function isState(value: unknown): value is RussianStyleState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RussianStyleState>;
  return candidate.version === 2 && typeof candidate.enabled === "boolean" && typeof candidate.diagnosticsEnabled === "boolean";
}

function isLegacyState(value: unknown): value is LegacyRussianStyleState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyRussianStyleState>;
  return candidate.version === 1 && typeof candidate.enabled === "boolean";
}

export async function loadRussianStyleState(path: string): Promise<LoadResult> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (isState(parsed)) return { state: parsed };
    if (isLegacyState(parsed)) return { state: { version: 2, enabled: parsed.enabled, diagnosticsEnabled: true } };
    return { state: { ...DEFAULT_RUSSIAN_STYLE_STATE }, warning: "Состояние russian-style имеет неизвестный формат; включён стандартный режим." };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: { ...DEFAULT_RUSSIAN_STYLE_STATE } };
    return { state: { ...DEFAULT_RUSSIAN_STYLE_STATE }, warning: "Не удалось прочитать состояние russian-style; включён стандартный режим." };
  }
}

export async function writeRussianStyleState(path: string, state: RussianStyleState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function withStateLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = spawn("flock", ["--exclusive", "--timeout", "5", "--conflict-exit-code", "75", `${path}.lock`, "sh", "-c", 'printf "locked\\n"; cat >/dev/null'], { stdio: ["pipe", "pipe", "pipe"] });
  await new Promise<void>((resolveReady, rejectReady) => {
    let stdout = "";
    let stderr = "";
    const cleanup = () => { lock.stdout.off("data", onStdout); lock.stderr.off("data", onStderr); lock.off("error", onError); lock.off("exit", onEarlyExit); };
    const onStdout = (chunk: Buffer) => { stdout += chunk.toString("utf8"); if (stdout.includes("locked\n")) { cleanup(); resolveReady(); } };
    const onStderr = (chunk: Buffer) => { stderr += chunk.toString("utf8"); };
    const onError = (error: Error) => { cleanup(); rejectReady(error); };
    const onEarlyExit = (code: number | null) => { cleanup(); rejectReady(new Error(`не удалось захватить блокировку russian-style (${code ?? "signal"}): ${stderr.trim()}`)); };
    lock.stdout.on("data", onStdout); lock.stderr.on("data", onStderr); lock.once("error", onError); lock.once("exit", onEarlyExit);
  });
  try { return await operation(); } finally { lock.stdin.end(); await once(lock, "exit"); }
}

export async function mutateRussianStyleState(path: string, action: StateAction): Promise<RussianStyleState> {
  return withStateLock(path, async () => {
    const current = (await loadRussianStyleState(path)).state;
    if (action.startsWith("diagnostics-")) {
      const diagnosticsAction = action.slice("diagnostics-".length);
      const diagnosticsEnabled = diagnosticsAction === "on" ? true : diagnosticsAction === "off" ? false : !current.diagnosticsEnabled;
      const next = { ...current, diagnosticsEnabled };
      await writeRussianStyleState(path, next);
      return next;
    }
    const enabled = action === "on" ? true : action === "off" ? false : !current.enabled;
    const next = { ...current, enabled };
    await writeRussianStyleState(path, next);
    return next;
  });
}

function statusText(state: RussianStyleState): string {
  return `russian-style:${state.enabled ? "on" : "off"} · diagnostics:${state.diagnosticsEnabled ? "on" : "off"}`;
}

function contentTextLength(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, item) => {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "text") return total;
    const text = (item as { text?: unknown }).text;
    return total + (typeof text === "string" ? text.length : 0);
  }, 0);
}

export function createRussianStyleExtension(overrides: DependencyOverrides = {}) {
  const { diagnosticDependencies: diagnosticOverrides, ...baseOverrides } = overrides;
  const diagnosticDependencies = {
    ...defaultRuntimeDiagnosticDependencies,
    ...diagnosticOverrides,
  };
  const dependencies: Dependencies = {
    statePath: process.env.PI_RUSSIAN_STYLE_STATE_PATH || defaultRussianStyleStatePath(),
    readState: loadRussianStyleState,
    mutateState: mutateRussianStyleState,
    diagnosticDependencies,
    queueSize: 8,
    ...baseOverrides,
  };
  return function russianStyleExtension(pi: ExtensionAPI): void {
    let state = { ...DEFAULT_RUSSIAN_STYLE_STATE };
    let shownWarning: string | undefined;
    let alive = true;
    let sessionGeneration = 0;
    let runStartedAt = dependencies.diagnosticDependencies.now();
    let toolCalls = 0;
    let toolResults = 0;
    let toolResultChars = 0;
    const contextObserver = new ContextObserver();
    const createQueue = () => new BoundedDiagnosticQueue<DiagnosticJob>(
      createDiagnosticWorker(dependencies.diagnosticDependencies),
      dependencies.queueSize,
    );
    let diagnostics = createQueue();
    const updateStatus = (ctx: { hasUI: boolean; ui: { setStatus: (key: string, text?: string) => void } }) => { if (ctx.hasUI) ctx.ui.setStatus("russian-style", statusText(state)); };
    const refreshState = async (ctx: { hasUI: boolean; ui: { setStatus: (key: string, text?: string) => void; notify: (text: string, level: "warning") => void } }) => {
      const loaded = await dependencies.readState(dependencies.statePath);
      state = loaded.state;
      updateStatus(ctx);
      if (loaded.warning && loaded.warning !== shownWarning && ctx.hasUI) { shownWarning = loaded.warning; ctx.ui.notify(loaded.warning, "warning"); }
    };
    pi.on("session_start", async (_event, ctx) => {
      sessionGeneration++;
      diagnostics.close();
      diagnostics = createQueue();
      contextObserver.reset("observation_start");
      alive = true;
      await refreshState(ctx);
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      sessionGeneration++;
      alive = false;
      diagnostics.close();
      contextObserver.invalidate();
      if (ctx.hasUI) ctx.ui.setStatus("russian-style", undefined);
    });
    pi.on("before_agent_start", async (event, ctx) => {
      runStartedAt = dependencies.diagnosticDependencies.now();
      contextObserver.invalidate();
      toolCalls = toolResults = toolResultChars = 0;
      await refreshState(ctx);
      const systemPrompt = applyRussianStylePrompt(event.systemPrompt, event.prompt ?? "", state.enabled);
      if (systemPrompt === event.systemPrompt) return;
      return { systemPrompt };
    });
    pi.on("session_compact", () => { contextObserver.reset("compaction"); });
    pi.on("session_tree", () => { contextObserver.reset("tree"); });
    pi.on("model_select", () => { contextObserver.reset("configuration"); });
    pi.on("context", (_event, ctx) => {
      if (alive && state.enabled && state.diagnosticsEnabled) contextObserver.observe(ctx);
      else contextObserver.invalidate();
    });
    pi.on("tool_execution_start", () => { toolCalls++; });
    pi.on("tool_execution_end", (event) => {
      toolResults++;
      toolResultChars += contentTextLength(event.result?.content);
    });
    pi.on("message_end", (event, ctx) => {
      if (!alive || !state.enabled || !state.diagnosticsEnabled || !isRussianDiagnosticCandidate(event.message)) return;
      const message = event.message as { timestamp: number; provider: string; model: string; content: unknown; stopReason: string };
      const text = assistantText(message);
      const sessionManager = ctx.sessionManager;
      const sessionId = sessionManager.getSessionId();
      const sessionFile = sessionManager.getSessionFile();
      const ui = ctx.hasUI ? ctx.ui : undefined;
      const generation = sessionGeneration;
      const notify = ui ? (text: string) => { if (alive && generation === sessionGeneration) ui.notify(text, "warning"); } : undefined;
      diagnostics.enqueue(`${message.timestamp}:${message.provider}:${message.model}:${text.length}`, {
        text,
        timestamp: message.timestamp,
        provider: message.provider,
        model: message.model,
        sessionId,
        sessionFile,
        context: contextObserver.snapshot(message.provider, message.model),
        stopReason: message.stopReason,
        work: {
          toolCalls,
          toolResults,
          toolResultChars,
          elapsedMs: Math.max(0, dependencies.diagnosticDependencies.now() - runStartedAt),
        },
        notify,
      });
    });
    pi.registerCommand("russian-style", {
      description: "Показать и отдельно управлять русским стилем и диагностикой",
      getArgumentCompletions: (prefix) => {
        const items = ["status", "on", "off", "toggle", "diagnostics", "diagnostics status", "diagnostics on", "diagnostics off", "diagnostics toggle"];
        const normalized = prefix.toLowerCase();
        const matches = items.filter((value) => value.startsWith(normalized)).map((value) => ({ value, label: value }));
        return matches.length > 0 ? matches : null;
      },
      handler: async (args, ctx) => {
        const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const diagnosticsCommand = tokens[0] === "diagnostics";
        const action = diagnosticsCommand ? tokens[1] || "status" : tokens[0] || "status";
        if (!["status", "on", "off", "toggle"].includes(action)) {
          if (ctx.hasUI) ctx.ui.notify("Использование: /russian-style status|on|off|toggle или /russian-style diagnostics status|on|off|toggle", "warning");
          return;
        }
        if (action === "status") {
          await refreshState(ctx);
          if (ctx.hasUI) ctx.ui.notify(`${statusText(state)} · /russian-style diagnostics on|off`, "info");
          return;
        }
        const stateAction = diagnosticsCommand ? `diagnostics-${action}` as StateAction : action as StateAction;
        try {
          state = await dependencies.mutateState(dependencies.statePath, stateAction);
          updateStatus(ctx);
          if (ctx.hasUI) ctx.ui.notify(statusText(state), "info");
        } catch (error) {
          await refreshState(ctx);
          if (ctx.hasUI) ctx.ui.notify(`Не удалось изменить russian-style: ${(error as Error).message}`, "error");
        }
      },
    });
    installHumanizer(pi);
  };
}

export default createRussianStyleExtension();
