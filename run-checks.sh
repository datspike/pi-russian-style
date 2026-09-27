#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"

bun test tests
bun run typecheck
python3 -m unittest discover -s tests -p 'humanizer_lint_test.py'

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
    Path("src/humanizer.ts"),
    Path("src/prompt.ts"),
    Path("tests/index.test.ts"),
    Path("tests/diagnostic-queue.test.ts"),
    Path("tests/diagnostics.test.ts"),
    Path("tests/runtime-diagnostics.test.ts"),
    Path("tests/humanizer_lint_test.py"),
    Path("prompts/ru-clean.md"),
    Path("skills/humanizer-ru/SKILL.md"),
    Path("skills/humanizer-ru/README.md"),
    Path("skills/humanizer-ru/references/editorial-contract.md"),
    Path("skills/humanizer-ru/references/patterns.md"),
    Path("skills/humanizer-ru/references/reader-check.md"),
    Path("skills/humanizer-ru/references/technical-jargon.md"),
    Path("skills/humanizer-ru/scripts/lint.py"),
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
