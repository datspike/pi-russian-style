import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

type Case = {
  id: string;
  prompt: string;
  expected_language: "ru" | "en";
  exact_spans: string[];
  provenance?: string[];
};

describe("regression corpus", () => {
  test("is compact, anonymized and structurally complete", async () => {
    const path = join(import.meta.dir, "..", "eval", "cases.json");
    const corpus = JSON.parse(await readFile(path, "utf8")) as { cases: Case[] };
    const ids = corpus.cases.map((item) => item.id);

    expect(corpus.cases.length).toBe(9);
    expect(new Set(ids).size).toBe(ids.length);
    expect(corpus.cases.some((item) => item.expected_language === "en")).toBeTrue();
    expect(corpus.cases.some((item) => item.id.includes("compaction"))).toBeTrue();

    for (const item of corpus.cases) {
      expect(item.prompt.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(item.exact_spans)).toBeTrue();
      expect(item.prompt).not.toMatch(/\/home\/|Documents\/obsidian-vault|PiAgent\/folder-history/);
      expect(item.provenance?.every((value) => /^source:style-\d{3}$/.test(value))).toBeTrue();
    }
  });
});
