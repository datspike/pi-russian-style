# Квитанция завершения: улучшение workflow Humanizer

## Проверенный объём

Изменения относятся к интерактивному Humanizer в `pi-russian-style`: `/ru-clean`, draft lifecycle, patchset, формальный lint, публикация и редакторские инструкции.

## Требования и доказательства

| Требование | Реализация и доказательство |
| --- | --- |
| `/ru-clean` создаёт draft сам | `src/humanizer.ts` создаёт revision 1 из последнего завершённого assistant-сообщения и передаёт модели явную инструкцию не вызывать `humanizer_create_draft`. |
| Повторный create объясняет режим | При job от `/ru-clean` `humanizer_create_draft` возвращает контекстное сообщение с дальнейшими доступными действиями. |
| Одиночные и пакетные правки защищены ревизией | `humanizer_patch_draft` и `humanizer_patch_draft_set` требуют `expectedRevision`. |
| Patchset атомарен | Все фрагменты валидируются до изменения draft; missing, ambiguous и overlapping patchset не меняют revision и содержимое. |
| Формальный lint доступен в tools | `humanizer_lint({ formal: true })` передаёт `--formal` в packaged lint script. |
| WARN не блокируют публикацию сами по себе | Tool отдельно обозначает contextual `WARN`; publication блокируют только недоступный lint или `ERROR`. |
| Pending publication не протекает в поздний ответ | Любой терминальный assistant-финал без точного `HUMANIZER_PUBLISH_READY` очищает job и pending state. |
| Источник `/ru-clean` не бывает промежуточным tool turn | `latestAssistant()` выбирает только `role: assistant` с `stopReason: "stop"`; regression test игнорирует поздний `toolUse`. |
| Документация соответствует runtime | `SKILL.md` и integration brief описывают precreated draft, `expectedRevision`, patchset, отсутствие reload-восстановления и реальную отмену pending publication. |

## Проверки

После последнего исправления выполнены:

```bash
bash run-checks.sh
# 38 Bun tests, TypeScript typecheck, 39 Python tests, benchmark

git diff --check
pi --no-extensions -e "$PWD" --list-models
```

Полный набор прошёл. Lint изменённых `SKILL.md` чистый; brief содержит только контекстные технические `WARN`, без `ERROR`.

## Независимое ревью

Выполнены четыре независимых Sol review на `openai/gpt-5.6-sol` с thinking `medium` и три исправительных цикла:

1. Подключены `formal`, отмена stale pending publication и исправлены ложные lifecycle-обещания в brief.
2. Brief приведён к реальному контракту reload и публикации.
3. Выбор источника ограничен завершёнными assistant-сообщениями.
4. Финальный review: `PASS`, подтверждённых P0/P1/P2 нет.

## Ограничение

Package smoke подтверждает загрузку пакета, а тесты покрывают lifecycle extension. Ручной TUI/RPC прогон с реальным модельным ходом остаётся отдельной непроверенной интеграционной границей.
