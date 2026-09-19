import copy
import hashlib
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


app = load_module("window_review_app", ROOT / "review/app.py")
summary = load_module("window_summary", ROOT / "review/summarize_annotations.py")


def records(segment="segment-1", model="model-1"):
    result = []
    for index, percent in enumerate([10, 25, 45, 70], 1):
        text = f"Русский ответ {segment} {index}"
        result.append({
            "schema": "pi-russian-style-diagnostic/v2", "rules_version": "rules-v2",
            "session_id": "session-private", "entry_id": f"{segment}-{index}",
            "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "message_timestamp": index, "provider": "provider", "model": model,
            "decision": "clean" if index == 1 else "record", "stop_reason": "stop",
            "context": {
                "segment_id": segment, "segment_reason": "observation_start",
                "observed_compactions": 0, "candidate_index": index,
                "prompt_version": "prompt-v1", "pi_system_prompt_sha256": "prompt-hash",
                "thinking_level": "medium", "context_tokens": percent * 10,
                "context_window": 1000, "context_percent": percent,
                "usage_source": "pi_context_estimate_before_call",
            },
        })
    return result


class WindowObservationTest(unittest.TestCase):
    def test_pairs_use_order_and_filling_not_decisions(self):
        rows = records()
        selected = app.window_pairs(list(reversed(rows)) + [rows[0]])
        self.assertEqual(selected, [[rows[0], rows[-1]]])
        for row in rows:
            row["decision"] = "notify"
        self.assertEqual(app.window_pairs(rows), [[rows[0], rows[-1]]])

    def test_rejects_short_unknown_legacy_nonfinal_and_mixed_segments(self):
        cases = []
        cases.append(records()[:3])
        for field, value in [("context_tokens", None), ("context_percent", float("nan")),
                             ("context_window", 0), ("candidate_index", 1),
                             ("pi_system_prompt_sha256", None), ("thinking_level", "high"),
                             ("observed_compactions", 1)]:
            rows = records()
            rows[-1]["context"][field] = value
            cases.append(rows)
        for field, value in [("schema", "pi-russian-style-diagnostic/v1"), ("stop_reason", "length"),
                             ("model", "other"), ("entry_id", None)]:
            rows = records()
            rows[-1][field] = value
            cases.append(rows)
        rows = records()
        rows[2]["context"].update(context_percent=5, context_tokens=50)
        cases.append(rows)
        rows = records()
        for index, row in enumerate(rows):
            row["context"].update(context_percent=10 + index, context_tokens=100 + index * 10)
        cases.append(rows)
        rows = records()
        rows[-1]["context"]["segment_id"] = "after-compaction"
        cases.append(rows)
        for rows in cases:
            with self.subTest(rows=rows):
                self.assertEqual(app.window_pairs(rows), [])

    def test_conflicting_duplicate_is_not_silently_counted(self):
        rows = records()
        changed = copy.deepcopy(rows[0])
        changed["context"]["candidate_index"] = 5
        self.assertEqual(app.window_pairs([*rows, changed]), [])

    def test_freeze_preserves_sample_and_clean_control(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private/sample.json"
            rows = records("clean") + records("other")
            for row in rows[4:]:
                row["decision"] = "record"
            frozen = app.freeze_window_sample(rows, path, 3)
            self.assertEqual(len(frozen["records"]), 2)
            self.assertTrue(any(row["decision"] == "clean" for row in frozen["records"]))
            before = path.read_bytes()
            self.assertEqual(app.freeze_window_sample(records("new"), path, 60), frozen)
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(app.load_window_sample(path), frozen)
            altered = copy.deepcopy(frozen)
            altered["records"][0]["context"]["context_percent"] = 99
            path.write_text(json.dumps(altered))
            with self.assertRaises(ValueError):
                app.load_window_sample(path)

    def test_no_eligible_data_does_not_freeze_empty_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.json"
            with self.assertRaises(ValueError):
                app.freeze_window_sample(records()[:2], path, 20)
            self.assertFalse(path.exists())

    def test_summary_keeps_partial_pairs_and_models_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            sample = app.freeze_window_sample(records("a") + records("b", "other-model"), Path(directory) / "sample.json", 4)
            empty = summary.summarize_windows(sample, {})
            self.assertEqual(empty["status"], "insufficient_labels")
            self.assertEqual(empty["comparisons"], [])
            annotations = {}
            for index, row in enumerate(sample["records"]):
                annotations[app.review_id(row)] = {
                    "text_sha256": row["text_sha256"], "overall": "good" if index % 2 == 0 else "poor",
                }
            full = summary.summarize_windows(sample, annotations)
            self.assertEqual(full["complete_pairs"], 2)
            self.assertEqual(len(full["comparisons"]), 2)
            self.assertTrue(all(group["worse_late"] == 1 for group in full["comparisons"]))
            self.assertEqual(full["clean_reviewed"], 2)
            self.assertEqual(full["poor_among_reviewed_clean"], 0)
            self.assertNotIn("session-private", json.dumps(full))
            self.assertNotIn("entry_id", json.dumps(full))
            annotations[app.review_id(sample["records"][-1])]["text_sha256"] = "wrong"
            partial = summary.summarize_windows(sample, annotations)
            self.assertEqual(partial["complete_pairs"], 1)
            self.assertEqual(partial["pending_pairs"], 1)
            self.assertEqual(partial["reviewed_answers"], 3)

    def test_summary_cli_needs_no_sessions_diagnostics_or_external_executables(self):
        import os
        import sys
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sample = root / "sample.json"
            app.freeze_window_sample(records(), sample, 2)
            result = subprocess.run([
                sys.executable, str(ROOT / "review/summarize_annotations.py"),
                "--window-sample", str(sample), "--annotations", str(root / "absent.json"),
                "--sessions", str(root / "no-sessions"), "--diagnostics", str(root / "no-diagnostics"),
            ], env={**os.environ, "PATH": str(root)}, capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout)["pending_pairs"], 1)

    def test_review_reuses_annotations_and_exposes_context_only_in_details(self):
        with tempfile.TemporaryDirectory() as directory:
            rows = records()
            row = rows[0]
            text = "Текст для разметки"
            texts = {(row["entry_id"], row["text_sha256"]): text}
            path = Path(directory) / "annotations.json"
            application = app.ReviewApplication([row], texts, path)
            item = application.items[0]
            application.save({"id": item["id"], "text_sha256": item["text_sha256"], "overall": "good"})
            restored = app.ReviewApplication([row], texts, path)
            self.assertEqual(restored.items[0]["annotation"]["overall"], "good")
            self.assertEqual(restored.items[0]["diagnostic"]["context"], row["context"])


if __name__ == "__main__":
    unittest.main()
