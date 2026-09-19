# Квитанция завершения: интерактивный Humanizer

## Проверенный снимок

- Репозиторий: `pi-russian-style`.
- База ревью: `ce0e12ea77293120693a0b7e0632179717abfdda` и текущий незакоммиченный diff, включая новые файлы.
- Область: stateful Humanizer, `/ru-clean`, packaged skill и lint, безопасная диагностика и связанные тесты.

## Требования и доказательства

| Требование | Реализация и доказательство |
| --- | --- |
| `/ru-clean` использует последнее содержательное assistant-сообщение | `src/humanizer.ts`: `latestAssistant()` читает только текущую ветку и исключает уже опубликованный Humanizer-результат. |
| Draft, точечная правка, lint, публикация и отмена | `humanizer_create_draft`, `humanizer_patch_draft`, `humanizer_lint`, `humanizer_inspect`, `humanizer_publish`, `humanizer_discard`. Точная замена требует единственного совпадения; новая ревизия инвалидирует старый lint. |
| Нет автоматической редактуры обычного ответа | Humanizer подключается отдельно от пассивной диагностики; tools включаются только для `/ru-clean` или явного `/skill:humanizer-ru`. |
| Публикация не меняет источник | `message_end` создаёт новое производное assistant-сообщение только для валидного `publishPending`; источник остаётся в истории. |
| Безопасная публикация | Нужны успешный lint текущей ревизии без `ERROR`, роль `assistant`, `stopReason: "stop"` и точный `HUMANIZER_PUBLISH_READY`. |
| File, docstring и comment staging | `humanizer_create_draft` принимает выбранный текст и метку источника; публикация в чат для такого draft запрещена, применение остаётся за обычными `read`/`ast-index-nav`/`edit`. |
| Skill и lint поставляются с package | `package.json` объявляет `pi.skills`; canonical copy находится в `skills/humanizer-ru/`. Vault skill — symlink на package copy. |
| Пассивная JSONL-диагностика не хранит исходные excerpts | `diagnosticHumanizerResult()` исключает `findings[].excerpt` и `output`; regression test использует `PRIVATE_TEST_SENTINEL`. |

## Проверки

После последнего исправления выполнены:

```bash
bash run-checks.sh
# 35 Bun tests, TypeScript typecheck, 39 Python tests, benchmark

git diff --check
pi --no-extensions -e "$PWD" --list-models
python3 skills/humanizer-ru/scripts/lint.py skills/humanizer-ru/SKILL.md
```

Все команды прошли. Линтер нового integration brief вернул `0 ERROR` и контекстные `WARN` для длинных тире и стрелок в технической матрице; текст не менялся ради нулевого числа предупреждений.

## Независимое ревью

Выполнено четыре независимых Astra-прохода, три исправительных цикла:

1. Исправлены privacy-проекция diagnostics и устаревшее ожидание lint test.
2. Исправлены default active tools и слишком широкая замена assistant-сообщения при публикации.
3. Исправлен вызов active-tool API внутри фабрики расширения до `Runner.bindCore()`; деактивация перенесена в `session_start`.
4. Финальный Astra review: `PASS`, P0/P1 отсутствуют.

Финальный reviewer: `openai/gpt-6-astra`, thinking `medium`.

## Ограничения

Smoke `pi --no-extensions -e "$PWD" --list-models` подтверждает загрузочный маршрут пакета, но не заменяет ручной TUI/RPC сценарий реального модельного хода. Автоматическая редактура нормальных ответов намеренно не добавлена.
