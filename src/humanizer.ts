import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assistantText, runHumanizer, textSha256, type HumanizerResult } from "./diagnostics.js";
import { DEFAULT_HUMANIZER_PATH, DEFAULT_HUMANIZER_TIMEOUT_MS } from "./runtime-diagnostics.js";

const TOOL_NAMES = [
  "humanizer_create_draft",
  "humanizer_patch_draft",
  "humanizer_patch_draft_set",
  "humanizer_lint",
  "humanizer_inspect",
  "humanizer_publish",
  "humanizer_discard",
] as const;

type Job = {
  id: string;
  sourceEntryId?: string;
  sourceHash: string;
  sourceLabel: string;
  contractVersion: string;
  draft: string;
  revision: number;
  lint?: HumanizerResult & { revision: number };
  publishPending: boolean;
};

type DraftPatch = { oldText: string; newText: string };

function applyPatchSet(draft: string, patches: DraftPatch[]): { draft?: string; error?: string } {
  if (patches.length === 0) return { error: "Нужна хотя бы одна правка; draft не изменён." };
  const seen = new Set<string>();
  const matches: Array<DraftPatch & { start: number; end: number }> = [];
  for (const patch of patches) {
    if (!patch.oldText) return { error: "Пустой oldText недопустим; draft не изменён." };
    if (seen.has(patch.oldText)) return { error: "Один oldText указан несколько раз; patchset неоднозначен и не применён." };
    seen.add(patch.oldText);
    const start = draft.indexOf(patch.oldText);
    if (start < 0) return { error: "Один из фрагментов не найден; patchset не применён, draft не изменён." };
    if (draft.indexOf(patch.oldText, start + patch.oldText.length) >= 0) return { error: "Один из фрагментов встречается несколько раз; добавь контекст, patchset не применён." };
    matches.push({ ...patch, start, end: start + patch.oldText.length });
  }
  matches.sort((left, right) => left.start - right.start);
  for (let index = 1; index < matches.length; index++) {
    if (matches[index].start < matches[index - 1].end) return { error: "Фрагменты patchset пересекаются; draft не изменён." };
  }
  let next = draft;
  for (const patch of [...matches].reverse()) next = `${next.slice(0, patch.start)}${patch.newText}${next.slice(patch.end)}`;
  return { draft: next };
}

function packagePath(relativePath: string): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", relativePath);
}

function promptText(): string {
  const source = readFileSync(packagePath("prompts/ru-clean.md"), "utf8");
  return source.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function jobId(): string {
  return `humanizer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function removeTools(pi: ExtensionAPI): void {
  const current = pi.getActiveTools();
  pi.setActiveTools(current.filter((tool) => !(TOOL_NAMES as readonly string[]).includes(tool)));
}

function activateTools(pi: ExtensionAPI): void {
  pi.setActiveTools([...new Set([...pi.getActiveTools(), ...TOOL_NAMES])]);
}

function latestAssistant(ctx: ExtensionContext): { id: string; text: string } | null {
  const branch = ctx.sessionManager.getBranch();
  for (const entry of [...branch].reverse() as any[]) {
    if (entry.type !== "message" || entry.message?.role !== "assistant" || entry.message?.stopReason !== "stop") continue;
    const text = assistantText(entry.message);
    if (!text || text.startsWith("> Humanizer ·")) continue;
    return { id: entry.id, text };
  }
  return null;
}

function lintSummary(lint: Job["lint"]): string {
  if (!lint) return "lint ещё не запускался";
  return `${lint.errors} ERROR, ${lint.warnings} WARN, ${lint.verdict}`;
}

const PUBLISH_READY = "HUMANIZER_PUBLISH_READY";
/** Registers the explicit, stateful editing path; ordinary russian-style remains passive. */
export function installHumanizer(pi: ExtensionAPI): void {
  let job: Job | undefined;

  const persist = () => { if (job) pi.appendEntry("russian-style-humanizer-job", job); };
  const result = (message: string, isError = false) => ({ content: [{ type: "text" as const, text: message }], details: {}, isError });
  const fail = (message: string) => result(message, true);
  const requireJob = () => job;
  const clear = () => { job = undefined; removeTools(pi); };
  const lintDraft = async (active: Job, formal: boolean | undefined, signal: AbortSignal | undefined) => {
    const path = process.env.PI_RUSSIAN_STYLE_LINTER_PATH || DEFAULT_HUMANIZER_PATH;
    const lint = await runHumanizer(active.draft, { path, timeoutMs: DEFAULT_HUMANIZER_TIMEOUT_MS, signal, formal });
    active.lint = { ...lint, revision: active.revision };
    persist();
    return lint;
  };
  const lintResult = (active: Job, lint: HumanizerResult) => {
    const errors = lint.findings.filter((finding) => finding.kind === "ERROR").slice(0, 8).map((finding) => finding.rule).join("; ");
    const warningNote = lint.warnings > 0 ? ` Контекстные WARN: ${lint.warnings}; они не блокируют публикацию сами по себе.` : "";
    return `Lint revision ${active.revision}: ${lintSummary(active.lint)}${errors ? `. ERROR: ${errors}` : ""}${warningNote}`;
  };

  pi.registerTool({
    name: "humanizer_create_draft",
    label: "Create Humanizer draft",
    description: "Создаёт текстовый draft для явной правки файла, docstring или комментария.",
    promptGuidelines: ["Use humanizer_create_draft only after /skill:humanizer-ru selected the exact text fragments to edit."],
    parameters: Type.Object({ text: Type.String(), sourceLabel: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      if (job) return fail(job.sourceEntryId
        ? "Draft уже создан командой /ru-clean. Не создавай новый: используй humanizer_inspect, patch, lint или publish."
        : "Уже есть активный Humanizer draft; заверши его или вызови humanizer_discard.");
      job = { id: jobId(), sourceHash: textSha256(params.text), sourceLabel: params.sourceLabel || "явно выбранный текст", contractVersion: "humanizer-ru", draft: params.text, revision: 1, publishPending: false };
      persist();
      return result(`Draft ${job.id} создан: revision 1, ${params.text.length} символов.`);
    },
  });

  pi.registerTool({
    name: "humanizer_patch_draft",
    label: "Patch Humanizer draft",
    description: "Точно заменяет один уникальный фрагмент draft в ожидаемой revision.",
    promptGuidelines: ["Use humanizer_patch_draft for one local edit. Pass the revision reported by humanizer_inspect; use humanizer_patch_draft_set for several dependent edits."],
    parameters: Type.Object({ expectedRevision: Type.Number(), oldText: Type.String(), newText: Type.String() }),
    async execute(_id, params) {
      const active = requireJob();
      if (!active) return fail("Нет активного Humanizer draft.");
      if (active.revision !== params.expectedRevision) return fail(`Draft уже имеет revision ${active.revision}; перечитай состояние и повтори правку.`);
      const applied = applyPatchSet(active.draft, [{ oldText: params.oldText, newText: params.newText }]);
      if (applied.error) return fail(applied.error);
      active.draft = applied.draft!;
      active.revision++;
      active.lint = undefined;
      active.publishPending = false;
      persist();
      return result(`Draft обновлён: revision ${active.revision}. Предыдущий lint инвалидирован.`);
    },
  });

  pi.registerTool({
    name: "humanizer_patch_draft_set",
    label: "Patch Humanizer draft set",
    description: "Атомарно применяет несколько точных непересекающихся правок и по умолчанию линтит новую revision.",
    promptGuidelines: ["Use humanizer_patch_draft_set when several edits form one revision. It lints the resulting revision by default; set lintAfter false only for a deliberately intermediate patchset. If any oldText is missing, ambiguous or overlapping, the whole patchset is rejected without mutation."],
    parameters: Type.Object({ expectedRevision: Type.Number(), patches: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { minItems: 1 }), lintAfter: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal) {
      const active = requireJob();
      if (!active) return fail("Нет активного Humanizer draft.");
      if (active.revision !== params.expectedRevision) return fail(`Draft уже имеет revision ${active.revision}; перечитай состояние и повтори patchset.`);
      const applied = applyPatchSet(active.draft, params.patches);
      if (applied.error) return fail(applied.error);
      active.draft = applied.draft!;
      active.revision++;
      active.lint = undefined;
      active.publishPending = false;
      persist();
      if (params.lintAfter === false) return result(`Patchset из ${params.patches.length} правок применён: revision ${active.revision}. Lint намеренно не запускался.`);
      const lint = await lintDraft(active, false, signal);
      return result(`Patchset из ${params.patches.length} правок применён. ${lintResult(active, lint)}`);
    },
  });

  pi.registerTool({
    name: "humanizer_lint",
    label: "Lint Humanizer draft",
    description: "Проверяет текущую ревизию draft линтером humanizer-ru без временного файла проекта.",
    promptGuidelines: ["Use humanizer_lint before humanizer_publish; ERROR blocks publication, while WARN requires contextual judgment. Set formal only for a genuinely formal genre."],
    parameters: Type.Object({ formal: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal) {
      const active = requireJob();
      if (!active) return fail("Нет активного Humanizer draft.");
      const lint = await lintDraft(active, params.formal, signal);
      return result(lintResult(active, lint));
    },
  });

  pi.registerTool({
    name: "humanizer_inspect",
    label: "Inspect Humanizer draft",
    description: "Возвращает краткое состояние draft, lint и разницу с источником.",
    parameters: Type.Object({}),
    async execute() {
      const active = requireJob();
      if (!active) return fail("Нет активного Humanizer draft.");
      return result(`Draft ${active.id}: ${active.sourceLabel}; revision ${active.revision}; ${lintSummary(active.lint)}; source ${active.sourceHash.slice(0, 12)}; draft ${textSha256(active.draft).slice(0, 12)}.`);
    },
  });

  pi.registerTool({
    name: "humanizer_publish",
    label: "Publish Humanizer draft",
    description: "Помечает проверенный draft для публикации отдельным assistant-сообщением.",
    promptGuidelines: ["Use humanizer_publish only after humanizer_lint on the final revision and only when there are no ERROR findings."],
    parameters: Type.Object({}),
    async execute() {
      const active = requireJob();
      if (!active) return fail("Нет активного Humanizer draft.");
      if (!active.sourceEntryId) return fail("Этот draft относится к файлу или фрагменту: примени его обычным edit, а не публикуй в чат.");
      if (!active.lint || active.lint.revision !== active.revision) return fail("Сначала запусти lint по текущей revision.");
      if (active.lint.status !== "ok" || active.lint.errors > 0) return fail("Lint недоступен или нашёл ERROR; публикация заблокирована.");
      active.publishPending = true;
      persist();
      return result(`Публикация подготовлена. Заверши ход ровно маркером ${PUBLISH_READY} без чистовика.`);
    },
  });

  pi.registerTool({
    name: "humanizer_discard",
    label: "Discard Humanizer draft",
    description: "Отменяет активную редактуру и убирает Humanizer tools.",
    parameters: Type.Object({}),
    async execute() {
      clear();
      return result("Humanizer draft отменён.");
    },
  });

  pi.registerCommand("ru-clean", {
    description: "Отредактировать последнее сообщение или явно названную цель через Humanizer",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (request) {
        if (job) { if (ctx.hasUI) ctx.ui.notify("Сначала заверши или отмени текущий Humanizer draft.", "warning"); return; }
        activateTools(pi);
        pi.sendUserMessage(`/skill:humanizer-ru ${request}`, ctx.isIdle()
          ? { expandPromptTemplates: true }
          : { deliverAs: "followUp", expandPromptTemplates: true });
        return;
      }
      if (job) { if (ctx.hasUI) ctx.ui.notify("Сначала заверши или отмени текущий Humanizer draft.", "warning"); return; }
      const source = latestAssistant(ctx);
      if (!source) { if (ctx.hasUI) ctx.ui.notify("Не найдено подходящее assistant-сообщение для редакции.", "warning"); return; }
      job = { id: jobId(), sourceEntryId: source.id, sourceHash: textSha256(source.text), sourceLabel: `assistant message ${source.id}`, contractVersion: "humanizer-ru", draft: source.text, revision: 1, publishPending: false };
      persist();
      activateTools(pi);
      pi.sendMessage({ customType: "russian-style-humanizer", display: false, details: { jobId: job.id }, content: `${promptText()}\n\nDraft уже создан extension в revision 1. Не вызывай humanizer_create_draft: работай с этим неизменяемым источником через humanizer_inspect, humanizer_patch_draft или humanizer_patch_draft_set, затем lint и publish. Сохраняй композицию. После humanizer_publish заверши ответ ровно маркером ${PUBLISH_READY}, без чистовика.\n\nИсточник:\n${source.text}` }, { triggerTurn: true });
    },
  });

  pi.on("input", (event) => {
    const suffix = event.source === "extension" ? null : event.text.match(/^(.*?)\s+\/ru-clean\s*$/s);
    if (suffix?.[1].trim()) {
      activateTools(pi);
      return { action: "transform", text: `/skill:humanizer-ru ${suffix[1].trim()}` };
    }
    if (/^\s*\/skill:humanizer-ru\b/.test(event.text)) activateTools(pi);
  });

  pi.on("message_end", (event) => {
    if (!job?.publishPending || event.message.role !== "assistant") return;
    const finalText = assistantText(event.message as { content?: unknown });
    if ((event.message as any).stopReason !== "stop" || finalText.trim() !== PUBLISH_READY) {
      clear();
      return;
    }
    const active = job;
    const content = `> Humanizer · редактура сообщения ${active.sourceEntryId}\n> Проверка: ${active.lint?.errors ?? 0} ERROR, ${active.lint?.warnings ?? 0} WARN\n\n${active.draft}`;
    pi.appendEntry("russian-style-humanizer-publication", { jobId: active.id, sourceEntryId: active.sourceEntryId, sourceHash: active.sourceHash, draftHash: textSha256(active.draft), revision: active.revision });
    clear();
    return { message: { ...event.message, content: [{ type: "text", text: content }] } as any };
  });

  pi.on("agent_settled", () => { if (!job || !job.publishPending) removeTools(pi); });
  // Active-tool APIs are bound only after the extension factory returns.
  pi.on("session_start", () => { if (job?.publishPending) job = undefined; removeTools(pi); });
  pi.on("session_shutdown", () => { clear(); });
}
