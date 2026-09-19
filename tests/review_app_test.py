import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).parents[1] / "review" / "app.py"
SPEC = importlib.util.spec_from_file_location("review_app", MODULE_PATH)
review_app = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(review_app)


class ReviewAppTest(unittest.TestCase):
    def record(self, entry_id, decision="record", verdict="clean", signals=None):
        text = f"Ответ {entry_id}"
        return {
            "session_id": "session-1",
            "entry_id": entry_id,
            "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "decision": decision,
            "humanizer": {"verdict": verdict},
            "signals": signals or [],
        }

    def test_sample_includes_diagnostic_strata(self):
        records = [
            self.record("notify", "notify", "rewrite"),
            self.record("review", "record", "review"),
            self.record("severe", signals=[{"severity": "severe"}]),
            self.record("mild", signals=[{"severity": "mild"}]),
            self.record("clean", "clean"),
        ]
        selected = review_app.select_sample(records, 10)
        self.assertEqual({review_app.sample_category(item) for item in selected}, {
            "notify", "record_review", "record_severe", "record_mild", "clean"
        })

    def test_sample_order_mixes_diagnostic_decisions_deterministically(self):
        records = [
            *(self.record(f"clean-{index}", "clean") for index in range(12)),
            *(self.record(f"record-{index}", "record") for index in range(6)),
        ]

        first = review_app.mix_by_diagnostic_decision(records)
        second = review_app.mix_by_diagnostic_decision(list(reversed(records)))
        decisions = [record["decision"] for record in first]
        longest_run = max(
            len(run)
            for start in range(len(decisions))
            for run in [
                decisions[start:next(
                    (index for index in range(start, len(decisions)) if decisions[index] != decisions[start]),
                    len(decisions),
                )]
            ]
        )

        self.assertEqual(
            [(record["entry_id"], record["decision"]) for record in first],
            [(record["entry_id"], record["decision"]) for record in second],
        )
        self.assertEqual({record["entry_id"] for record in first}, {record["entry_id"] for record in records})
        self.assertLessEqual(longest_run, 2)

    def test_load_texts_checks_full_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "session.jsonl"
            text = "Русский ответ для проверки"
            digest = hashlib.sha256(text.encode()).hexdigest()
            rows = [
                {"type": "session", "id": "session-1"},
                {"type": "message", "id": "answer-1", "message": {
                    "role": "assistant", "timestamp": 100, "provider": "provider", "model": "model",
                    "content": [{"type": "text", "text": text}],
                }},
            ]
            path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")
            record = {
                "session_id": "session-1", "entry_id": "answer-1", "text_sha256": digest,
                "message_timestamp": 100, "provider": "provider", "model": "model",
            }
            self.assertEqual(review_app.load_texts([record], root), {("answer-1", digest): text})
            self.assertEqual(review_app.load_texts([{**record, "provider": "wrong"}], root), {})

    def test_annotation_ranges_are_validated_and_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "annotations.json"
            record = self.record("answer-1", "notify", "rewrite")
            text = "Ответ answer-1"
            app = review_app.ReviewApplication([record], {("answer-1", record["text_sha256"]): text}, output)
            item = app.items[0]
            stored = app.save({
                "id": item["id"], "text_sha256": item["text_sha256"],
                "overall": "poor", "usefulness": "correct", "ranges": [{"start": 0, "end": 5}],
            })
            self.assertEqual(stored["ranges"][0]["text"], "Ответ")
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertEqual(app.items[0]["annotation"], stored)
            with self.assertRaises(ValueError):
                app.save({"id": item["id"], "text_sha256": item["text_sha256"], "ranges": [{"start": -1, "end": 2}]})


if __name__ == "__main__":
    unittest.main()
