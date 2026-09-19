#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"

bun test tests
bun run typecheck
python3 -m unittest discover -s tests -p '*_test.py'
mkdir -p .runtime
bun benchmarks/message-end.ts > .runtime/message-end-benchmark-latest.json
python3 - <<'PY'
import json
from pathlib import Path

for path in [Path("benchmarks/results/2026-09-03-message-end.json"), Path(".runtime/message-end-benchmark-latest.json")]:
    result = json.loads(path.read_text(encoding="utf-8"))
    if result["acceptance_budget"]["result"] != "pass":
        raise SystemExit(f"{path}: message_end performance budget failed")
    required = {"critical_path", "background_processing", "queue_load", "heap_delta_bytes_before_worker"}
    missing = required - result.keys()
    if missing:
        raise SystemExit(f"{path}: missing benchmark sections: {sorted(missing)}")
    if result["background_processing"]["humanizer_status"] != "ok":
        raise SystemExit(f"{path}: humanizer benchmark did not run successfully")
    queue = result["queue_load"]
    if queue["maximum_workers"] != 1 or queue["dropped"] <= 0 or queue["queue_limit"] != 8:
        raise SystemExit(f"{path}: bounded queue load check failed")
PY

python3 - <<'PY'
from pathlib import Path

paths = [
    Path("AGENTS.md"),
    Path("README.md"),
    Path("package.json"),
    Path("run-checks.sh"),
    Path("src/index.ts"),
    Path("src/diagnostic-queue.ts"),
    Path("src/diagnostics.ts"),
    Path("src/runtime-diagnostics.ts"),
    Path("src/prompt.ts"),
    Path("tests/index.test.ts"),
    Path("tests/diagnostic-queue.test.ts"),
    Path("tests/diagnostics.test.ts"),
    Path("tests/runtime-diagnostics.test.ts"),
    Path("tests/corpus.test.ts"),
    Path("tests/review_app_test.py"),
    Path("tests/window_observation_test.py"),
    Path("docs/window-observation.md"),
    Path("review/app.py"),
    Path("review/static/index.html"),
    Path("review/evaluate-rules.ts"),
    Path("review/summarize_annotations.py"),
    Path("benchmarks/message-end.ts"),
    Path("benchmarks/results/2026-09-03-message-end.json"),
    Path("prompts/ru-clean.md"),
    Path("eval/cases.json"),
    Path("LICENSE"),
]
errors = []
for path in paths:
    data = path.read_bytes()
    if data and not data.endswith(b"\n"):
        errors.append(f"{path}: missing final newline")
    for number, line in enumerate(data.decode("utf-8").splitlines(), 1):
        if line.rstrip(" \t") != line:
            errors.append(f"{path}:{number}: trailing whitespace")
if errors:
    raise SystemExit("\n".join(errors))
PY
