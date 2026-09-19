import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  applyRussianStylePrompt,
  isExplicitEnglishRequest,
  RUSSIAN_STYLE_PROMPT_MARKER,
} from "../src/prompt.js";
import {
  createRussianStyleExtension,
  DEFAULT_RUSSIAN_STYLE_STATE,
  loadRussianStyleState,
  mutateRussianStyleState,
  writeRussianStyleState,
} from "../src/index.js";

type Handler = (...args: any[]) => any;

function createHarness(statePath: string, overrides: Record<string, unknown> = {}) {
  const events = new Map<string, Handler>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  let activeTools: string[] = ["read", "edit"];
  const statuses: Array<[string, string | undefined]> = [];
  const notifications: Array<[string, string]> = [];
  const entries: any[] = [];
  const sent: any[] = [];
  const sentUser: Array<{ content: unknown; options: unknown }> = [];
  const addHandler = (name: string, handler: Handler) => {
    const previous = events.get(name);
    if (!previous) { events.set(name, handler); return; }
    events.set(name, (...args: any[]) => {
      const first = previous(...args);
      const second = handler(...args);
      if (first instanceof Promise || second instanceof Promise) {
        return Promise.all([first, second]).then((results) => results.find((result) => result !== undefined));
      }
      return first ?? second;
    });
  };
  const pi = {
    on: addHandler,
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getActiveTools: () => activeTools,
    setActiveTools: (next: string[]) => { activeTools = next; },
    appendEntry: (_type: string, data: any) => entries.push({ type: "custom", data }),
    sendMessage: (message: any) => sent.push(message),
    sendUserMessage: (content: unknown, options: unknown) => sentUser.push({ content, options }),
  };
  createRussianStyleExtension({ statePath, ...overrides })(pi as any);
  const ctx = {
    hasUI: true,
    ui: { setStatus: (key: string, text?: string) => statuses.push([key, text]), notify: (text: string, level: string) => notifications.push([text, level]) },
    sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined, getEntries: () => entries, getBranch: () => entries },
    isIdle: () => true,
  };
  return { events, commands, tools, sent, sentUser, getActiveTools: () => activeTools, statuses, notifications, entries, ctx };
}

describe("state", () => {
  test("missing and invalid state default to enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-state-"));
    expect(await loadRussianStyleState(join(root, "missing.json"))).toEqual({ state: DEFAULT_RUSSIAN_STYLE_STATE });
    const path = join(root, "invalid.json");
    await writeFile(path, "{not-json", "utf8");
    const result = await loadRussianStyleState(path);
    expect(result.state).toEqual(DEFAULT_RUSSIAN_STYLE_STATE);
    expect(result.warning).toContain("Не удалось прочитать");
  });

  test("state writer is atomic, private and newline-terminated", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-write-"));
    const path = join(root, "nested", "state.json");
    await writeRussianStyleState(path, { version: 1, enabled: false });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, enabled: false });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  test("concurrent toggles use the latest state under flock", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-concurrent-"));
    const path = join(root, "state.json");
    await writeRussianStyleState(path, { version: 1, enabled: true });
    await Promise.all(Array.from({ length: 8 }, () => mutateRussianStyleState(path, "toggle")));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, enabled: true });
  });
});

describe("prompt", () => {
  test("recognizes explicit English requests", () => {
    for (const text of [
      "на английском",
      "по-английски",
      "на английском языке",
      "Ответь на английском, пожалуйста",
      "Мне нужен ответ на английском языке",
      "Оставь только английский вариант",
      "answer in English",
      "respond in English",
      "write in English",
      "reply in English",
      "Can you answer in English?",
      "Use English, please",
      "in English, please",
      "English, please",
      "English only",
      "Write the answer in English",
      "Could you provide the answer in English?",
      "Can you please answer in English?",
      "I want an answer in English",
      "Переведи это на английский",
    ]) {
      expect(isExplicitEnglishRequest(text)).toBe(true);
    }
  });

  test("does not treat negation or quoted mentions as an English request", () => {
    for (const text of [
      "не отвечай на английском",
      "не нужно отвечать на английском",
      "Ответь не на английском, а на русском",
      "В отчёте есть текст на английском языке",
      "Проверь, есть ли ответ на английском языке",
      "don't answer in English",
      "please do not respond in English",
      "I do not want you to write in English",
      "Что означает «answer in English»?",
      "Объясни фразу “answer in English”",
      "Разбери выражение ‘English only’",
      "Объясни строку `English only`",
      "~~~\nanswer in English\n~~~",
      "> answer in English",
      "В документации есть пункт. Answer in English — это заголовок.",
      "Это инструкция. Write in English — название режима.",
      "Ниже приведён пример. Respond in English означает имя команды.",
    ]) {
      expect(isExplicitEnglishRequest(text)).toBe(false);
    }
  });

  test("technical English inside a Russian request does not disable the layer", () => {
    expect(isExplicitEnglishRequest("Исправь API error в русском отчёте")).toBe(false);
    expect(applyRussianStylePrompt("base", "Проверь endpoint и напиши вывод", true)).toContain(RUSSIAN_STYLE_PROMPT_MARKER);
  });

  test("adds exactly one block, preserves pohuy and skips explicit English", () => {
    const pohuy = "base\n<!-- pohuy-mode -->\npohuy\n<!-- /pohuy-mode -->";
    const first = applyRussianStylePrompt(pohuy, "Подготовь отчёт", true);
    const second = applyRussianStylePrompt(first, "Подготовь отчёт", true);
    expect(first).toContain("<!-- pohuy-mode -->");
    expect(first).toContain(RUSSIAN_STYLE_PROMPT_MARKER);
    expect(first.split(RUSSIAN_STYLE_PROMPT_MARKER)).toHaveLength(2);
    expect(first.split("<!-- /russian-style -->")).toHaveLength(2);
    expect(second).toBe(first);
    expect(applyRussianStylePrompt("base", "answer in English", true)).toBe("base");
    expect(applyRussianStylePrompt("base", "Подготовь отчёт", false)).toBe("base");
  });
});

describe("extension lifecycle and commands", () => {
  test("extension factory defers active-tool access until session_start", () => {
    const events = new Map<string, Handler>();
    const pi = {
      on: (name: string, handler: Handler) => events.set(name, handler),
      registerCommand: () => {},
      registerTool: () => {},
      getActiveTools: () => { throw new Error("not bound"); },
      setActiveTools: () => { throw new Error("not bound"); },
      appendEntry: () => {},
      sendMessage: () => {},
    };
    expect(() => createRussianStyleExtension({ statePath: "/unused" })(pi as any)).not.toThrow();
    expect(events.has("session_start")).toBe(true);
  });

  test("default-on lifecycle injects prompt and publishes status", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-lifecycle-"));
    const harness = createHarness(join(root, "state.json"));
    await harness.events.get("session_start")?.({}, harness.ctx);
    expect(harness.statuses.at(-1)).toEqual(["russian-style", "russian-style:on"]);
    const result = await harness.events.get("before_agent_start")?.({ prompt: "Подготовь отчёт", systemPrompt: "base" }, harness.ctx);
    expect(result.systemPrompt).toContain(RUSSIAN_STYLE_PROMPT_MARKER);
    await harness.events.get("session_shutdown")?.({}, harness.ctx);
    expect(harness.statuses.at(-1)).toEqual(["russian-style", undefined]);
  });

  test("commands persist on, off, toggle and leave status read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-commands-"));
    const path = join(root, "state.json");
    const harness = createHarness(path);
    await harness.commands.get("russian-style").handler("status", harness.ctx);
    expect(await readFile(path).catch(() => "")).toBe("");
    await harness.commands.get("russian-style").handler("off", harness.ctx);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, enabled: false });
    await harness.commands.get("russian-style").handler("on", harness.ctx);
    await harness.commands.get("russian-style").handler("toggle", harness.ctx);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, enabled: false });
    await harness.commands.get("russian-style").handler("wat", harness.ctx);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, enabled: false });
  });

  test("headless lifecycle changes prompt without UI calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-headless-"));
    const harness = createHarness(join(root, "state.json"));
    const headless = { ...harness.ctx, hasUI: false };
    await harness.events.get("session_start")?.({}, headless);
    const result = await harness.events.get("before_agent_start")?.({ prompt: "Сделай кратко", systemPrompt: "base" }, headless);
    expect(result.systemPrompt).toContain(RUSSIAN_STYLE_PROMPT_MARKER);
    expect(harness.statuses).toHaveLength(0);
    expect(harness.notifications).toHaveLength(0);
  });

  test("ru-clean publishes a derived assistant message and keeps its source", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-humanizer-"));
    const harness = createHarness(join(root, "state.json"));
    await harness.events.get("session_start")?.({}, harness.ctx);
    const source = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Обычный русский технический ответ без явных нарушений." }] };
    harness.entries.push({ type: "message", id: "source-1", message: source });
    await harness.commands.get("ru-clean").handler("", harness.ctx);
    expect(harness.sent).toHaveLength(1);
    expect(harness.getActiveTools()).toContain("humanizer_publish");
    expect(harness.sent[0].content).toContain("Draft уже создан extension");
    const duplicateCreate = await harness.tools.get("humanizer_create_draft").execute("create", { text: "другой текст" }, undefined);
    expect(duplicateCreate.isError).toBe(true);
    expect(duplicateCreate.content[0].text).toContain("Draft уже создан командой /ru-clean");
    await harness.tools.get("humanizer_lint").execute("lint", {}, undefined);
    await harness.tools.get("humanizer_publish").execute("publish", {}, undefined);
    const replaced = harness.events.get("message_end")?.({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "HUMANIZER_PUBLISH_READY" }] } }, harness.ctx);
    expect(replaced.message.content[0].text).toContain("Humanizer · редактура сообщения source-1");
    expect(replaced.message.content[0].text).toContain(source.content[0].text);
    expect(harness.entries.find((entry) => entry.id === "source-1")?.message).toEqual(source);
  });

  test("ru-clean forwards an explicit request to the Humanizer skill without creating a chat draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-explicit-target-"));
    const harness = createHarness(join(root, "state.json"));
    await harness.events.get("session_start")?.({}, harness.ctx);
    await harness.commands.get("ru-clean").handler("исправь этот файл", harness.ctx);
    expect(harness.sent).toHaveLength(0);
    expect(harness.sentUser).toEqual([{
      content: "/skill:humanizer-ru исправь этот файл",
      options: { expandPromptTemplates: true },
    }]);
    expect(harness.getActiveTools()).toContain("humanizer_create_draft");
    const draft = await harness.tools.get("humanizer_create_draft").execute("create", { text: "Текст файла.", sourceLabel: "file" }, undefined);
    expect(draft.isError).toBe(false);
    const publish = await harness.tools.get("humanizer_publish").execute("publish", {}, undefined);
    expect(publish.isError).toBe(true);
    expect(publish.content[0].text).toContain("примени его обычным edit");
  });

  test("ru-clean queues an explicit request after an active turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-explicit-target-follow-up-"));
    const harness = createHarness(join(root, "state.json"));
    await harness.events.get("session_start")?.({}, harness.ctx);
    await harness.commands.get("ru-clean").handler("исправь этот файл", { ...harness.ctx, isIdle: () => false });
    expect(harness.sentUser).toEqual([{
      content: "/skill:humanizer-ru исправь этот файл",
      options: { deliverAs: "followUp", expandPromptTemplates: true },
    }]);
    expect(harness.getActiveTools()).toContain("humanizer_create_draft");
  });

  test("ru-clean suffix transforms a natural request into the Humanizer skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-suffix-target-"));
    const harness = createHarness(join(root, "state.json"));
    await harness.events.get("session_start")?.({}, harness.ctx);
    const result = await harness.events.get("input")?.({
      text: "проверь этот док /ru-clean ",
      source: "interactive",
    }, harness.ctx);
    expect(result).toEqual({ action: "transform", text: "/skill:humanizer-ru проверь этот док" });
    expect(harness.getActiveTools()).toContain("humanizer_create_draft");
  });

  test("ru-clean ignores a nonterminal assistant message when selecting its source", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-source-selection-"));
    const harness = createHarness(join(root, "state.json"));
    await harness.events.get("session_start")?.({}, harness.ctx);
    harness.entries.push({ type: "message", id: "final", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Завершённый ответ." }] } });
    harness.entries.push({ type: "message", id: "tool-turn", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Промежуточный текст." }] } });
    await harness.commands.get("ru-clean").handler("", harness.ctx);
    expect(harness.sent[0].content).toContain("Завершённый ответ.");
    expect(harness.sent[0].content).not.toContain("Промежуточный текст.");
  });

  test("failed publish final clears pending draft instead of leaking it into a later turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-publish-cancel-"));
    const harness = createHarness(join(root, "state.json"));
    await harness.events.get("session_start")?.({}, harness.ctx);
    harness.entries.push({ type: "message", id: "source-1", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Обычный русский технический ответ без явных нарушений." }] } });
    await harness.commands.get("ru-clean").handler("", harness.ctx);
    await harness.tools.get("humanizer_lint").execute("lint", {}, undefined);
    await harness.tools.get("humanizer_publish").execute("publish", {}, undefined);
    expect(harness.events.get("message_end")?.({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Не служебный финал" }] } }, harness.ctx)).toBeUndefined();
    expect(harness.getActiveTools()).not.toContain("humanizer_publish");
    await harness.commands.get("ru-clean").handler("", harness.ctx);
    expect(harness.sent).toHaveLength(2);
  });

  test("patchset is atomic and revision-guarded", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-patchset-"));
    const harness = createHarness(join(root, "state.json"));
    await harness.events.get("session_start")?.({}, harness.ctx);
    harness.events.get("input")?.({ text: "/skill:humanizer-ru" }, harness.ctx);
    await harness.tools.get("humanizer_create_draft").execute("create", { text: "Первый фрагмент. Второй фрагмент.", sourceLabel: "comment" }, undefined);
    const patchset = await harness.tools.get("humanizer_patch_draft_set").execute("patchset", {
      expectedRevision: 1,
      patches: [{ oldText: "Первый фрагмент", newText: "Первый исправленный фрагмент" }, { oldText: "Второй фрагмент", newText: "Второй исправленный фрагмент" }],
    }, undefined);
    expect(patchset.isError).toBe(false);
    expect(patchset.content[0].text).toContain("Lint revision 2");
    expect((await harness.tools.get("humanizer_inspect").execute("inspect", {}, undefined)).content[0].text).toContain("revision 2");
    const stale = await harness.tools.get("humanizer_patch_draft").execute("patch", { expectedRevision: 1, oldText: "Первый исправленный фрагмент", newText: "Не должен примениться" }, undefined);
    expect(stale.isError).toBe(true);
    const rejected = await harness.tools.get("humanizer_patch_draft_set").execute("patchset", { expectedRevision: 2, patches: [{ oldText: "Первый исправленный фрагмент", newText: "X" }, { oldText: "отсутствует", newText: "Y" }] }, undefined);
    expect(rejected.isError).toBe(true);
    expect((await harness.tools.get("humanizer_inspect").execute("inspect", {}, undefined)).content[0].text).toContain("revision 2");
    const intermediate = await harness.tools.get("humanizer_patch_draft_set").execute("patchset", { expectedRevision: 2, patches: [{ oldText: "Первый исправленный фрагмент", newText: "Первый промежуточный фрагмент" }], lintAfter: false }, undefined);
    expect(intermediate.content[0].text).toContain("Lint намеренно не запускался");
    expect((await harness.tools.get("humanizer_inspect").execute("inspect", {}, undefined)).content[0].text).toContain("revision 3; lint ещё не запускался");
    const formalDraft = await harness.tools.get("humanizer_lint").execute("lint", { formal: true }, undefined);
    expect(formalDraft.content[0].text).toContain("Lint revision 3");
  });

  test("message_end enqueues diagnostics without blocking or changing the answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-diagnostics-"));
    const records: any[] = [];
    let lintStarted = false;
    let releaseLint!: () => void;
    const lintGate = new Promise<void>((resolve) => { releaseLint = resolve; });
    const harness = createHarness(join(root, "state.json"), {
      diagnosticDependencies: {
        diagnosticsPath: join(root, "diagnostics.jsonl"),
        humanizerPath: "/unused",
        humanizerTimeoutMs: 100,
        now: () => 1000,
        lint: async () => {
          lintStarted = true;
          await lintGate;
          return { status: "ok", errors: 2, warnings: 6, score: 12, verdict: "rewrite", findings: [] };
        },
        appendRecord: async (_path: string, record: any) => { records.push(record); },
        resolveEntryId: async () => "answer-1",
      },
    });
    const text = "Реализовал результат. Semantic authority связывает editorial finding с identity ledger, posting preview и manifest. ".repeat(3);
    const message = {
      role: "assistant", stopReason: "stop", timestamp: 123, provider: "openai", model: "test-model",
      content: [{ type: "text", text }],
    };
    harness.entries.push({ type: "message", id: "answer-1", message });
    const snapshot = structuredClone(message);
    const returned = harness.events.get("message_end")?.({ message }, harness.ctx);
    expect(returned).toBeUndefined();
    expect(lintStarted).toBe(false);
    expect(message).toEqual(snapshot);
    await Bun.sleep(0);
    expect(lintStarted).toBe(true);
    releaseLint();
    for (let attempt = 0; attempt < 50 && records.length === 0; attempt++) await Bun.sleep(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ entry_id: "answer-1", decision: "notify" });
    expect(harness.notifications.at(-1)?.[0]).toContain("итоговый ответ стоит проверить");
    await harness.events.get("session_shutdown")?.({}, harness.ctx);
  });

  test("disabled mode does not enqueue diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-disabled-diagnostics-"));
    let lintCalls = 0;
    const harness = createHarness(join(root, "state.json"), {
      diagnosticDependencies: {
        diagnosticsPath: join(root, "diagnostics.jsonl"), humanizerPath: "/unused", humanizerTimeoutMs: 10, now: Date.now,
        lint: async () => { lintCalls++; return { status: "ok", errors: 0, warnings: 0, score: 0, verdict: "clean", findings: [] }; },
        appendRecord: async () => {},
        resolveEntryId: async () => null,
      },
    });
    await harness.commands.get("russian-style").handler("off", harness.ctx);
    const text = "Этот итоговый русский технический ответ достаточно длинный для диагностического фильтра, но отключённый режим обязан полностью его пропустить.";
    harness.events.get("message_end")?.({ message: { role: "assistant", stopReason: "stop", timestamp: 1, provider: "test", model: "test", content: [{ type: "text", text }] } }, harness.ctx);
    await Bun.sleep(0);
    expect(lintCalls).toBe(0);
  });

  test("recreates the diagnostic queue after a session restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-restart-diagnostics-"));
    let writes = 0;
    const harness = createHarness(join(root, "state.json"), {
      diagnosticDependencies: {
        diagnosticsPath: join(root, "diagnostics.jsonl"), humanizerPath: "/unused", humanizerTimeoutMs: 10, now: Date.now,
        lint: async () => ({ status: "ok", errors: 0, warnings: 0, score: 0, verdict: "clean", findings: [] }),
        appendRecord: async () => { writes++; },
        resolveEntryId: async () => "answer-2",
      },
    });
    await harness.events.get("session_shutdown")?.({}, harness.ctx);
    await harness.events.get("session_start")?.({}, harness.ctx);
    const text = "После перезапуска сессии этот достаточно длинный русский технический ответ должен снова попасть в фоновую диагностическую очередь. Повторная сессия не должна оставлять очередь навсегда закрытой.";
    harness.events.get("message_end")?.({ message: { role: "assistant", stopReason: "stop", timestamp: 2, provider: "test", model: "test", content: [{ type: "text", text }] } }, harness.ctx);
    for (let attempt = 0; attempt < 20 && writes === 0; attempt++) await Bun.sleep(1);
    expect(writes).toBe(1);
  });
});

test("context events preserve snapshots and only successful compaction splits the segment", async () => {
  const records: any[] = [];
  const harness = createHarness("/unused", {
    readState: async () => ({ state: { version: 1, enabled: true } }),
    diagnosticDependencies: {
      lint: async () => ({ status: "ok", errors: 0, warnings: 0, score: 0, verdict: "clean", findings: [] }),
      appendRecord: async (_path: string, record: any) => { records.push(record); },
      resolveEntryId: async () => "entry",
    },
  });
  let tokens: number | null = 100;
  const ctx = { ...harness.ctx, model: { provider: "test", id: "test" }, thinkingLevel: "medium",
    getContextUsage: () => ({ tokens, contextWindow: 1000 }), getSystemPrompt: () => "Правила",
  };
  const text = "Русский итоговый ответ достаточно длинный для проверки фоновой диагностики. ".repeat(3);
  const capture = async (timestamp: number) => {
    const count = records.length;
    expect(harness.events.get("context")?.({ messages: [] }, ctx)).toBeUndefined();
    expect(harness.events.get("message_end")?.({ message: { role: "assistant", stopReason: "stop", timestamp, provider: "test", model: "test", content: [{ type: "text", text }] } }, ctx)).toBeUndefined();
    for (let attempt = 0; attempt < 100 && records.length === count; attempt++) await Bun.sleep(1);
    expect(records.length).toBe(count + 1);
    return records.at(-1).context;
  };
  await harness.events.get("session_start")?.({}, ctx);
  const first = await capture(1);
  tokens = 700;
  harness.events.get("session_before_compact")?.({}, ctx);
  harness.events.get("session_compact_failed")?.({}, ctx);
  const second = await capture(2);
  expect(second.segment_id).toBe(first.segment_id);
  expect(first.context_tokens).toBe(100);
  expect(second.context_tokens).toBe(700);
  harness.events.get("session_compact")?.({}, ctx);
  tokens = null;
  const compacted = await capture(3);
  expect(compacted.segment_id).not.toBe(first.segment_id);
  expect(compacted.segment_reason).toBe("compaction");
  expect(compacted.context_tokens).toBeNull();
  harness.events.get("session_tree")?.({}, ctx);
  const tree = await capture(4);
  expect(tree.segment_id).not.toBe(compacted.segment_id);
  await harness.events.get("session_shutdown")?.({}, ctx);
  await harness.events.get("session_start")?.({}, ctx);
  const restarted = await capture(5);
  expect(restarted.segment_id).not.toBe(tree.segment_id);
  expect(records[0].stop_reason).toBe("stop");
  await harness.events.get("session_shutdown")?.({}, ctx);
});
