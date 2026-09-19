#!/usr/bin/env python3
"""Local review UI for pi-russian-style diagnostic samples."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import tempfile
from collections import defaultdict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import urlparse

DEFAULT_DIAGNOSTICS = Path.home() / ".pi/agent/state/russian-style-diagnostics.jsonl"
DEFAULT_SESSIONS = Path.home() / ".pi/agent/sessions"
DEFAULT_OUTPUT = Path(".runtime/style-review/annotations.json")
STATIC_DIR = Path(__file__).with_name("static")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows
    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}:{line_number}: invalid JSON: {error}") from error
            if isinstance(value, dict):
                rows.append(value)
    return rows


def stable_order(record: dict[str, Any]) -> str:
    value = f"{record.get('text_sha256', '')}:{record.get('entry_id', '')}"
    return hashlib.sha256(value.encode()).hexdigest()


def has_severe_signal(record: dict[str, Any]) -> bool:
    return any(signal.get("severity") == "severe" for signal in record.get("signals", []))


def sample_category(record: dict[str, Any]) -> str:
    if record.get("decision") == "notify":
        return "notify"
    verdict = record.get("humanizer", {}).get("verdict")
    if verdict == "rewrite":
        return "record_rewrite"
    if verdict == "review":
        return "record_review"
    if record.get("decision") == "record" and has_severe_signal(record):
        return "record_severe"
    if record.get("decision") == "record":
        return "record_mild"
    return "clean"


def select_sample(records: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    quotas = {
        "notify": 10,
        "record_rewrite": 8,
        "record_review": 10,
        "record_severe": 12,
        "record_mild": 10,
        "clean": 10,
    }
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        if record.get("entry_id") and record.get("text_sha256"):
            groups[sample_category(record)].append(record)
    for values in groups.values():
        values.sort(key=stable_order)

    selected: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for category in quotas:
        for record in groups[category][: quotas[category]]:
            key = (record["entry_id"], record["text_sha256"])
            if key not in seen:
                seen.add(key)
                selected.append(record)

    if len(selected) < limit:
        remainder = sorted(records, key=stable_order)
        for record in remainder:
            key = (record.get("entry_id"), record.get("text_sha256"))
            if None in key or key in seen:
                continue
            seen.add(key)
            selected.append(record)
            if len(selected) >= limit:
                break
    return selected[:limit]


def mix_by_diagnostic_decision(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Равномерно распределяет диагностические решения, сохраняя воспроизводимый порядок."""
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        groups[str(record.get("decision", "unknown"))].append(record)
    for values in groups.values():
        values.sort(key=stable_order)

    weights = {decision: len(values) for decision, values in groups.items()}
    scores = {decision: 0 for decision in groups}
    positions = {decision: 0 for decision in groups}
    total = len(records)
    priority = {"notify": 0, "record": 1, "clean": 2}
    mixed: list[dict[str, Any]] = []

    while len(mixed) < total:
        active = [decision for decision, values in groups.items() if positions[decision] < len(values)]
        for decision in active:
            scores[decision] += weights[decision]
        selected = max(active, key=lambda decision: (scores[decision], -priority.get(decision, 99), decision))
        scores[selected] -= total
        mixed.append(groups[selected][positions[selected]])
        positions[selected] += 1

    return mixed


def review_id(record: dict[str, Any]) -> str:
    return f"{record['session_id']}:{record['entry_id']}:{record['text_sha256'][:12]}"


def window_pairs(records: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Отбирает края непрерывных участков, не используя оценки качества."""
    groups: dict[tuple, dict[str, dict[str, Any]]] = defaultdict(dict)
    invalid: set[tuple] = set()
    for record in records:
        context = record.get("context")
        if record.get("schema") != "pi-russian-style-diagnostic/v2" or not isinstance(context, dict):
            continue
        if record.get("stop_reason") != "stop":
            continue
        required = ("session_id", "entry_id", "text_sha256", "provider", "model", "rules_version")
        if not all(isinstance(record.get(key), str) and record[key] for key in required):
            continue
        if not all(isinstance(context.get(key), str) and context[key] for key in ("segment_id", "prompt_version", "pi_system_prompt_sha256")):
            continue
        key = (record["session_id"], context["segment_id"])
        index = context.get("candidate_index")
        percent = context.get("context_percent")
        tokens = context.get("context_tokens")
        window = context.get("context_window")
        if type(index) is not int or index < 1:
            invalid.add(key)
            continue
        if (not all(type(value) in (int, float) and math.isfinite(value) for value in (percent, tokens, window))
                or tokens < 0 or window <= 0 or not 0 <= percent <= 100
                or not math.isclose(percent, 100 * tokens / window, abs_tol=0.001)
                or context.get("usage_source") != "pi_context_estimate_before_call"):
            continue
        identity = review_id(record)
        previous = groups[key].get(identity)
        if previous is not None and previous != record:
            invalid.add(key)
        groups[key][identity] = record

    pairs = []
    for key, by_id in groups.items():
        values = sorted(by_id.values(), key=lambda row: row["context"]["candidate_index"])
        if key in invalid or len(values) < 4:
            continue
        signatures = {(
            row["provider"], row["model"], row["rules_version"], row["context"]["prompt_version"],
            row["context"]["pi_system_prompt_sha256"], row["context"].get("thinking_level"),
            row["context"]["context_window"], row["context"].get("observed_compactions"),
        ) for row in values}
        indexes = [row["context"]["candidate_index"] for row in values]
        percents = [row["context"]["context_percent"] for row in values]
        if len(signatures) != 1 or len(set(indexes)) != len(indexes):
            continue
        if any(right < left for left, right in zip(percents, percents[1:])):
            continue
        if percents[-1] - percents[0] < 20:
            continue
        pairs.append([values[0], values[-1]])
    return sorted(pairs, key=lambda pair: stable_order(pair[0]))


def load_window_sample(path: Path) -> dict[str, Any]:
    sample = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(sample, dict) or sample.get("schema") != "pi-russian-style-window-sample/v1":
        raise ValueError("Неизвестный формат выборки окон")
    records = sample.get("records")
    if not isinstance(records, list) or not records or len(records) % 2:
        raise ValueError("В выборке должны быть полные пары")
    seen = set()
    for index in range(0, len(records), 2):
        early, late = records[index:index + 2]
        # Сохраняем полные наблюдения, чтобы проверить отбор краёв при повторном открытии.
        if not isinstance(early, dict) or not isinstance(late, dict):
            raise ValueError("Некорректная пара")
        for row in (early, late):
            identity = review_id(row)
            if identity in seen:
                raise ValueError("Повтор ответа в выборке")
            seen.add(identity)
    expected = window_pairs(sample.get("observations", []))
    valid = {(review_id(pair[0]), review_id(pair[1])) for pair in expected}
    if any((review_id(records[i]), review_id(records[i + 1])) not in valid for i in range(0, len(records), 2)):
        raise ValueError("Пара не подтверждается наблюдениями")
    source = {review_id(row): row for pair in expected for row in pair}
    if any(row != source[review_id(row)] for row in records):
        raise ValueError("Метаданные пары отличаются от наблюдений")
    return sample


def freeze_window_sample(records: list[dict[str, Any]], path: Path, limit: int) -> dict[str, Any]:
    """Фиксирует выборку один раз; повторный запуск не меняет её состав."""
    if path.exists():
        return load_window_sample(path)
    if limit < 2:
        raise ValueError("Для пары нужен --limit не меньше 2")
    pairs = window_pairs(records)
    # Одна контрольная пара с clean, если такая есть; остальные по хэшу.
    controls = [pair for pair in pairs if any(row.get("decision") == "clean" for row in pair)]
    chosen = controls[:1]
    chosen.extend(pair for pair in pairs if pair not in chosen)
    chosen = chosen[:limit // 2]
    if not chosen:
        raise ValueError("Пока нет участков: нужны 4 ответа и рост заполнения минимум на 20 процентных пунктов")
    selected = [row for pair in chosen for row in pair]
    segments = {(row["session_id"], row["context"]["segment_id"]) for row in selected}
    observations = [row for row in records if isinstance(row.get("context"), dict)
                    and (row.get("session_id"), row["context"].get("segment_id")) in segments]
    sample = {
        "schema": "pi-russian-style-window-sample/v1",
        "selection": "first_last_min4_span20_clean_control",
        "records": selected,
        "observations": observations,
        "eligible_segments": len(pairs),
        "source_records": len(records),
    }
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        json.dump(sample, target, ensure_ascii=False, indent=2)
        target.write("\n")
    return sample


def assistant_text(message: dict[str, Any]) -> str:
    return "\n".join(
        item.get("text", "")
        for item in message.get("content", [])
        if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str)
    )


def load_texts(records: list[dict[str, Any]], sessions_root: Path) -> dict[tuple[str, str], str]:
    if not records:
        return {}
    by_timestamp: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        by_timestamp[int(record["message_timestamp"])].append(record)
    timestamps = sorted(str(value) for value in by_timestamp)
    try:
        result = subprocess.run(
            ["rg", "-l", "-F", "-f", "-", str(sessions_root)],
            input="\n".join(timestamps) + "\n", text=True, capture_output=True, check=False,
        )
        paths = [Path(value) for value in result.stdout.splitlines() if value]
    except OSError:
        paths = list(sessions_root.rglob("*.jsonl"))

    texts: dict[tuple[str, str], str] = {}
    wanted = {(record["entry_id"], record["text_sha256"]) for record in records}
    for path in paths:
        for entry in read_jsonl(path):
            if entry.get("type") != "message":
                continue
            message = entry.get("message", {})
            timestamp = message.get("timestamp")
            targets = by_timestamp.get(timestamp) if isinstance(timestamp, int) else None
            if not targets:
                continue
            text = assistant_text(message)
            digest = hashlib.sha256(text.encode()).hexdigest()
            for record in targets:
                if (
                    message.get("role") == "assistant"
                    and entry.get("id") == record.get("entry_id")
                    and message.get("provider") == record.get("provider")
                    and message.get("model") == record.get("model")
                    and digest == record.get("text_sha256")
                ):
                    texts[(record["entry_id"], record["text_sha256"])] = text
            if wanted.issubset(texts):
                return texts
    return texts


def load_annotations(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    return value if isinstance(value, dict) else {}


def write_annotations(path: Path, annotations: dict[str, dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            json.dump(annotations, target, ensure_ascii=False, indent=2, sort_keys=True)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class ReviewApplication:
    def __init__(self, records: list[dict[str, Any]], texts: dict[tuple[str, str], str], output: Path):
        self.output = output
        self.annotations = load_annotations(output)
        self.save_lock = Lock()
        self.items: list[dict[str, Any]] = []
        for index, record in enumerate(records):
            key = (record["entry_id"], record["text_sha256"])
            text = texts.get(key)
            if text is None:
                continue
            item_id = review_id(record)
            self.items.append({
                "id": item_id,
                "index": index,
                "text": text,
                "text_sha256": record["text_sha256"],
                "category": sample_category(record),
                "diagnostic": {
                    "decision": record.get("decision"),
                    "model": record.get("model"),
                    "chars": record.get("chars"),
                    "humanizer": record.get("humanizer"),
                    "signals": record.get("signals", []),
                    "preceding_work": record.get("preceding_work"),
                    "context": record.get("context"),
                },
                "annotation": self.annotations.get(item_id),
            })

    def save(self, annotation: dict[str, Any]) -> dict[str, Any]:
        item_id = annotation.get("id")
        item = next((candidate for candidate in self.items if candidate["id"] == item_id), None)
        if not item:
            raise ValueError("unknown item")
        if annotation.get("text_sha256") != item["text_sha256"]:
            raise ValueError("text hash mismatch")
        if annotation.get("overall") not in {None, "good", "acceptable", "poor"}:
            raise ValueError("invalid overall assessment")
        if annotation.get("usefulness") not in {None, "correct", "partial", "false_positive", "missed"}:
            raise ValueError("invalid usefulness assessment")
        ranges = annotation.get("ranges", [])
        if not isinstance(ranges, list):
            raise ValueError("invalid ranges")
        normalized = []
        for value in ranges:
            start, end = value.get("start"), value.get("end")
            if not isinstance(start, int) or not isinstance(end, int) or start < 0 or end <= start or end > len(item["text"]):
                raise ValueError("invalid text range")
            normalized.append({"start": start, "end": end, "text": item["text"][start:end]})
        stored = {
            "id": item_id,
            "text_sha256": item["text_sha256"],
            "overall": annotation.get("overall"),
            "usefulness": annotation.get("usefulness"),
            "ranges": sorted(normalized, key=lambda value: (value["start"], value["end"])),
        }
        with self.save_lock:
            self.annotations[item_id] = stored
            item["annotation"] = stored
            write_annotations(self.output, self.annotations)
        return stored


def make_handler(application: ReviewApplication):
    class Handler(BaseHTTPRequestHandler):
        def send_json(self, value: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
            body = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            path = urlparse(self.path).path
            if path == "/api/sample":
                self.send_json({"items": application.items, "output": str(application.output), "count": len(application.items)})
                return
            target = STATIC_DIR / ("index.html" if path == "/" else path.lstrip("/"))
            if not target.is_file() or STATIC_DIR.resolve() not in target.resolve().parents:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            body = target.read_bytes()
            content_type = "text/html; charset=utf-8" if target.suffix == ".html" else "application/octet-stream"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            if urlparse(self.path).path != "/api/annotation":
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length))
                self.send_json(application.save(payload))
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)

        def log_message(self, format: str, *args: Any) -> None:
            return

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--diagnostics", type=Path, default=DEFAULT_DIAGNOSTICS)
    parser.add_argument("--sessions", type=Path, default=DEFAULT_SESSIONS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--limit", type=int, default=60)
    parser.add_argument("--rules-version", help="Only review records produced by this diagnostic rules version")
    parser.add_argument("--window-sample", type=Path, help="Создать или открыть фиксированную выборку ранних и поздних ответов")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if args.window_sample and args.window_sample.resolve() == args.output.resolve():
        parser.error("Выборка и разметка должны храниться в разных файлах")

    if args.window_sample and args.window_sample.exists():
        records = load_window_sample(args.window_sample)["records"]
        all_texts = load_texts(records, args.sessions)
    else:
        all_records = read_jsonl(args.diagnostics)
        if args.rules_version:
            all_records = [record for record in all_records if record.get("rules_version") == args.rules_version]
        if args.window_sample:
            records = freeze_window_sample(all_records, args.window_sample, args.limit)["records"]
            all_texts = load_texts(records, args.sessions)
        else:
            all_texts = load_texts(all_records, args.sessions)
            available = [record for record in all_records if (record.get("entry_id"), record.get("text_sha256")) in all_texts]
            records = mix_by_diagnostic_decision(select_sample(available, args.limit))
    if args.window_sample:
        if any((row["entry_id"], row["text_sha256"]) not in all_texts for row in records):
            raise SystemExit("Не все тексты фиксированной выборки доступны; состав не изменён")
        # Перемешиваем позиции; метаданные остаются в свёрнутой диагностике.
        records = sorted(records, key=stable_order)
    application = ReviewApplication(records, all_texts, args.output)
    if not application.items:
        raise SystemExit("No diagnostic texts could be reconstructed from Pi sessions")
    server = ThreadingHTTPServer((args.host, args.port), make_handler(application))
    print(f"Review {len(application.items)} answers at http://{args.host}:{args.port}", flush=True)
    print(f"Annotations: {args.output}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
