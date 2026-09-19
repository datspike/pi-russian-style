#!/usr/bin/env python3
"""Aggregate private review annotations and evaluate the current diagnostic rules."""

from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
from collections import Counter, defaultdict
from statistics import median
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parents[1]
APP_PATH = ROOT / "review/app.py"


def load_review_app():
    spec = importlib.util.spec_from_file_location("review_app", APP_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def counts(values) -> dict[str, int]:
    return dict(sorted(Counter(values).items()))


def ratio(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator else 0.0


def summarize_windows(sample: dict[str, Any], annotations: dict[str, Any]) -> dict[str, Any]:
    """Сравнивает только полностью размеченные пары, без чтения текстов и вызовов моделей."""
    app = load_review_app()
    records = sample["records"]
    groups = defaultdict(list)
    score = {"good": 0, "acceptable": 1, "poor": 2}
    reviewed = 0
    clean_reviewed = clean_poor = 0
    completed = 0
    for index in range(0, len(records), 2):
        pair = records[index:index + 2]
        labels = []
        for row in pair:
            annotation = annotations.get(app.review_id(row), {})
            label = annotation.get("overall")
            if annotation.get("text_sha256") != row["text_sha256"] or label not in score:
                label = None
            labels.append(label)
            reviewed += label is not None
            if row.get("decision") == "clean" and label is not None:
                clean_reviewed += 1
                clean_poor += label == "poor"
        if None in labels:
            continue
        completed += 1
        early, late = pair
        context = early["context"]
        key = (early["provider"], early["model"], context.get("thinking_level"),
               context["prompt_version"], context["pi_system_prompt_sha256"],
               early["rules_version"], context["context_window"])
        groups[key].append((early, late, labels))

    comparisons = []
    for key, pairs in sorted(groups.items(), key=lambda item: repr(item[0])):
        deltas = [score[labels[1]] - score[labels[0]] for _, _, labels in pairs]
        comparisons.append({
            "provider": key[0], "model": key[1], "thinking_level": key[2],
            "prompt_version": key[3], "pi_system_prompt_sha256": key[4],
            "rules_version": key[5], "context_window": key[6],
            "paired_segments": len(pairs),
            "sessions": len({early["session_id"] for early, _, _ in pairs}),
            "early": counts(labels[0] for _, _, labels in pairs),
            "late": counts(labels[1] for _, _, labels in pairs),
            "worse_late": sum(delta > 0 for delta in deltas),
            "better_late": sum(delta < 0 for delta in deltas),
            "unchanged": sum(delta == 0 for delta in deltas),
            "median_early_percent": median(early["context"]["context_percent"] for early, _, _ in pairs),
            "median_late_percent": median(late["context"]["context_percent"] for _, late, _ in pairs),
            "median_candidate_distance": median(late["context"]["candidate_index"] - early["context"]["candidate_index"] for early, late, _ in pairs),
        })
    return {
        "schema": "pi-russian-style-window-summary/v1",
        "status": "descriptive_only" if completed else "insufficient_labels",
        "selected_answers": len(records), "reviewed_answers": reviewed,
        "complete_pairs": completed, "pending_pairs": len(records) // 2 - completed,
        "clean_selected": sum(row.get("decision") == "clean" for row in records),
        "clean_reviewed": clean_reviewed, "poor_among_reviewed_clean": clean_poor,
        "eligible_segments_at_freeze": sample["eligible_segments"],
        "source_records_at_freeze": sample["source_records"],
        "comparisons": comparisons,
        "method_note": "Описательное сравнение разных задач внутри наблюдаемых участков. Одна пара с clean включается при наличии. Это не оценка распространённости дефектов и не доказательство влияния заполнения окна. Участки одной сессии зависимы; неизвестные оценки и короткие участки не сравниваются.",
    }


def main() -> None:
    app = load_review_app()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--diagnostics", type=Path, default=app.DEFAULT_DIAGNOSTICS)
    parser.add_argument("--annotations", type=Path, default=ROOT / ".runtime/style-review/annotations.json")
    parser.add_argument("--sessions", type=Path, default=app.DEFAULT_SESSIONS)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--window-sample", type=Path, help="Сводка фиксированной выборки окон без повторного запуска правил")
    args = parser.parse_args()

    if args.window_sample:
        if args.output and args.output.resolve() in {args.window_sample.resolve(), args.annotations.resolve()}:
            parser.error("Сводка не должна перезаписывать выборку или разметку")
        sample = app.load_window_sample(args.window_sample)
        result = summarize_windows(sample, app.load_annotations(args.annotations))
        if args.output:
            app.write_annotations(args.output, result)
        else:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    records = app.read_jsonl(args.diagnostics)
    annotations = app.load_annotations(args.annotations)
    texts = app.load_texts(records, args.sessions)
    reviewed: list[dict[str, Any]] = []
    for record in records:
        review_id = f"{record['session_id']}:{record['entry_id']}:{record['text_sha256'][:12]}"
        annotation = annotations.get(review_id)
        text = texts.get((record["entry_id"], record["text_sha256"]))
        if annotation and text is not None:
            reviewed.append({"id": review_id, "record": record, "annotation": annotation, "text": text})

    payload = "".join(json.dumps({
        "id": item["id"], "text": item["text"], "humanizer": item["record"]["humanizer"],
    }, ensure_ascii=False) + "\n" for item in reviewed)
    process = subprocess.run(
        ["bun", str(ROOT / "review/evaluate-rules.ts")], input=payload, text=True, capture_output=True, check=True,
    )
    evaluated = {row["id"]: row for row in (json.loads(line) for line in process.stdout.splitlines() if line)}

    expected_for = {"good": "clean", "acceptable": "record", "poor": "notify"}
    old_correct = new_correct = 0
    old_notify_true = new_notify_true = 0
    old_notify_total = new_notify_total = 0
    poor_total = 0
    old_notify_poor = new_notify_poor = 0
    for item in reviewed:
        annotation = item["annotation"]
        expected = expected_for[annotation["overall"]]
        old = item["record"]["decision"]
        new = evaluated[item["id"]]["decision"]
        old_correct += old == expected
        new_correct += new == expected
        poor_total += annotation["overall"] == "poor"
        if old == "notify":
            old_notify_total += 1
            old_notify_true += annotation["overall"] == "poor"
        if new == "notify":
            new_notify_total += 1
            new_notify_true += annotation["overall"] == "poor"
        if annotation["overall"] == "poor":
            old_notify_poor += old == "notify"
            new_notify_poor += new == "notify"

    total = len(reviewed)
    result = {
        "schema": "pi-russian-style-review-summary/v1",
        "generated_at": "2026-09-03",
        "reviewed": total,
        "overall": counts(item["annotation"]["overall"] for item in reviewed),
        "usefulness_of_original_decision": counts(item["annotation"]["usefulness"] for item in reviewed),
        "highlighting": {
            "answers_with_ranges": sum(bool(item["annotation"]["ranges"]) for item in reviewed),
            "ranges": sum(len(item["annotation"]["ranges"]) for item in reviewed),
            "highlighted_chars": sum(len(value["text"]) for item in reviewed for value in item["annotation"]["ranges"]),
        },
        "old_rules": {
            "version": "2026-09-03-v1",
            "decisions": counts(item["record"]["decision"] for item in reviewed),
            "proxy_exact_matches": old_correct,
            "proxy_exact_match_rate": ratio(old_correct, total),
            "notify_precision_for_poor": ratio(old_notify_true, old_notify_total),
            "notify_recall_for_poor": ratio(old_notify_poor, poor_total),
        },
        "new_rules": {
            "version": "2026-09-03-v2",
            "decisions": counts(evaluated[item["id"]]["decision"] for item in reviewed),
            "proxy_exact_matches": new_correct,
            "proxy_exact_match_rate": ratio(new_correct, total),
            "notify_precision_for_poor": ratio(new_notify_true, new_notify_total),
            "notify_recall_for_poor": ratio(new_notify_poor, poor_total),
        },
        "method_note": "Proxy target maps good→clean, acceptable→record, poor→notify. The same labels informed v2, so these metrics are resubstitution estimates and require a fresh holdout review.",
    }
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
