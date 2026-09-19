import { decideDiagnostic, technicalSignals, type HumanizerResult } from "../src/diagnostics.js";

type Input = { id: string; text: string; humanizer: HumanizerResult };

const input = (await Bun.stdin.text())
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Input);

for (const item of input) {
  const signals = technicalSignals(item.text);
  console.log(JSON.stringify({ id: item.id, decision: decideDiagnostic(item.humanizer, signals), signals }));
}
