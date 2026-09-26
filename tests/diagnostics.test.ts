import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  decideDiagnostic,
  isRussianDiagnosticCandidate,
  runHumanizer,
  technicalSignals,
  textSha256,
  type HumanizerResult,
} from "../src/diagnostics.js";
import { DEFAULT_HUMANIZER_PATH } from "../src/runtime-diagnostics.js";

const cleanHumanizer: HumanizerResult = {
  status: "ok",
  errors: 0,
  warnings: 0,
  score: 0,
  verdict: "clean",
  findings: [],
};

function assistant(text: string, stopReason = "stop") {
  return { role: "assistant", stopReason, content: [{ type: "text", text }] };
}

describe("diagnostic candidate filter", () => {
  test("accepts final Russian prose and skips tool turns, short text and English", () => {
    const russian = "Результат готов. Этот ответ достаточно длинный для проверки русского технического текста и содержит прямой вывод без вмешательства в пользовательское сообщение.";
    expect(isRussianDiagnosticCandidate(assistant(russian))).toBe(true);
    expect(isRussianDiagnosticCandidate(assistant(russian, "toolUse"))).toBe(false);
    expect(isRussianDiagnosticCandidate(assistant("Коротко."))).toBe(false);
    expect(isRussianDiagnosticCandidate(assistant("This final answer is deliberately written only in English and must never enter Russian diagnostics despite being sufficiently long for the length threshold."))).toBe(false);
  });
});

describe("technical signals", () => {
  test("ignores protected code and reports clustered prose problems", () => {
    const text = `Реализовал большой runtime pipeline для production review. В этом workflow используется fallback guard.\n\n\`runtime workflow production fallback guard\`\n\n${"Подробное описание результата. ".repeat(240)}`;
    const signals = technicalSignals(text);
    expect(signals.find((item) => item.rule === "internal_english")?.severity).toBe("severe");
    expect(signals.find((item) => item.rule === "process_opening")).toBeDefined();
    expect(signals.find((item) => item.rule === "excessive_length")).toBeDefined();
    expect(signals.find((item) => item.rule === "style_debt_english")).toBeUndefined();
  });

  test("uses manually confirmed style-debt English for decisions", () => {
    expect(decideDiagnostic(cleanHumanizer, [])).toBe("clean");
    expect(decideDiagnostic(cleanHumanizer, [{ rule: "mixed_sentences", severity: "severe", count: 8 }])).toBe("clean");
    expect(decideDiagnostic({ ...cleanHumanizer, verdict: "rewrite" }, [])).toBe("clean");
    expect(decideDiagnostic({ ...cleanHumanizer, status: "timeout", verdict: "unavailable" }, [])).toBe("record");
    expect(decideDiagnostic(cleanHumanizer, [{ rule: "style_debt_english", severity: "mild", count: 3, distinct: 2 }])).toBe("record");
    expect(decideDiagnostic(cleanHumanizer, [{ rule: "style_debt_english", severity: "severe", count: 12, distinct: 4 }])).toBe("notify");
  });

  test("counts repeated style-debt terms outside protected code", () => {
    const text = "Semantic authority и editorial finding связаны через identity ledger. Posting preview использует semantic authority, editorial finding, identity ledger и manifest.";
    const protectedText = "`semantic authority editorial finding identity ledger`\n```text\nsemantic authority editorial finding identity ledger\n```\nhttps://example.test/semantic/authority/editorial/finding";
    const signal = technicalSignals(`${text}\n\n${protectedText}`)
      .find((item) => item.rule === "style_debt_english");
    expect(signal).toMatchObject({ severity: "severe", count: 15 });
    expect(signal?.distinct).toBeGreaterThanOrEqual(6);
  });

  test("text hash is stable", () => {
    expect(textSha256("текст")).toBe(textSha256("текст"));
    expect(textSha256("текст")).not.toBe(textSha256("другой текст"));
  });
});

describe("humanizer process", () => {
  test("parses the existing linter and times out a stuck process", async () => {
    const root = await mkdtemp(join(tmpdir(), "russian-style-linter-"));
    const slow = join(root, "slow.py");
    await writeFile(slow, "import time\ntime.sleep(10)\n", "utf8");
    const timedOut = await runHumanizer("Текст", { path: slow, timeoutMs: 20 });
    expect(timedOut.status).toBe("timeout");

    const path = DEFAULT_HUMANIZER_PATH;
    const actual = await runHumanizer("Обычный русский технический ответ без явных нарушений.", { path, timeoutMs: 1500 });
    expect(actual.status).toBe("ok");
    expect(actual.verdict).toBe("clean");
    const violation = await runHumanizer("Важно отметить — это runtime workflow.", { path, timeoutMs: 1500 });
    expect(violation.verdict).toBe("clean");
    expect(violation.errors).toBe(0);
    expect(violation.warnings).toBeGreaterThan(0);
    expect(violation.findings.map((item) => item.rule)).toContain("23 длинное тире");
    const formal = await runHumanizer("Важно отметить — это runtime workflow.", { path, timeoutMs: 1500, formal: true });
    expect(formal.warnings).toBeLessThan(violation.warnings);
    expect(formal.findings.map((item) => item.rule)).not.toContain("23 длинное тире");
  });

  test("keeps blocking lint errors distinct from background decisions", async () => {
    const text = "Ссылка из ответа: https://example.test/?utm_source=openai";
    const actual = await runHumanizer(text, { path: DEFAULT_HUMANIZER_PATH, timeoutMs: 1500 });
    expect(actual.status).toBe("ok");
    expect(actual.errors).toBe(1);
    expect(actual.verdict).toBe("review");
    expect(actual.findings.map((item) => item.rule)).toContain("A utm/referrer чат-бота");
    expect(decideDiagnostic(actual, technicalSignals(text))).toBe("clean");
  });
});
