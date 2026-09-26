"""Публичный CLI Humanizer: вердикт не должен противоречить блокирующему ERROR."""

import subprocess
import sys
import unittest
from pathlib import Path


LINTER = Path(__file__).parents[1] / "skills" / "humanizer-ru" / "scripts" / "lint.py"


class HumanizerLintCliTest(unittest.TestCase):
    def run_lint(self, text):
        return subprocess.run(
            [sys.executable, str(LINTER)], input=text, capture_output=True, text=True, check=False,
        )

    def test_pasted_tracking_url_reports_error_without_clean_verdict(self):
        result = self.run_lint("Ссылка из ответа: https://example.test/?utm_source=openai")
        self.assertEqual(result.returncode, 1)
        self.assertIn("ERROR строка 1: [A utm/referrer чат-бота]", result.stdout)
        self.assertIn("-> review", result.stdout)
        self.assertNotIn("-> clean", result.stdout)

    def test_cited_tracking_url_remains_a_blocking_artifact(self):
        result = self.run_lint("Цитируемый адрес: «https://example.test/?utm_source=openai».")
        self.assertEqual(result.returncode, 1)
        self.assertIn("ERROR строка 1: [A utm/referrer чат-бота]", result.stdout)
        self.assertIn("-> review", result.stdout)

    def test_ordinary_url_and_quoted_code_are_not_chatbot_artifacts(self):
        result = self.run_lint(
            "Сохрани https://example.test/?utm_source=newsletter и "
            "`https://example.test/?utm_source=openai` без изменений."
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("итого: 0 errors", result.stdout)


if __name__ == "__main__":
    unittest.main()
