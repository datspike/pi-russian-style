#!/usr/bin/env python3
"""Линтер признаков AI-слопа для humanizer-ru.

Использование:
    python3 scripts/lint.py file.md               # или stdin: python3 scripts/lint.py < file.md
    python3 scripts/lint.py --formal file.md      # формальный жанр: без стилевых сигналов
    python3 scripts/lint.py --self-test

ERROR = артефакты копипаста из чат-ботов (гейт: exit 1).
WARN  = контекстные стилевые сигналы. Оценивай их кластерами: одиночный WARN
        не требует правки, а ноль WARN не доказывает качество текста.

Линт гоняется только по чистовику, без changelog и цитат «до».
Артефакт в бэктиках не считается: так артефакты цитируют, а не копипастят.
"""
import re
import sys

# --- класс A: артефакты копипаста из чат-ботов (мгновенный вердикт) ---
# Порт из Vladimir-Human/humanizer-ru (MIT); regex там проверены fixtures.
# Гоняются по сырому тексту (включая URL), но без code-блоков и бэктиков.
ARTIFACTS = [
    ("A contentReference-сноска", re.compile(r":contentReference\[[^\]\n]+\]|oai_citation:\d+‡|\boaicite:\d+")),
    ("A turn-метка", re.compile(r"\bturn\d+(?:search|file|fetch|image|news|video|ref)\d+|citeturn")),
    ("A utm/referrer чат-бота", re.compile(r"utm_source=(?:chatgpt|copilot)\.com|utm_source=openai|referrer=grok\.com")),
    ("A grok-карточка", re.compile(r"grok_card://|grok_render_citation_card_json|<grok-card\b")),
    ("A gemini-цитата", re.compile(r"vertexaisearch\S*grounding-api-redirect|\[cite_start\]|\[cite:\s*\d+|\[span_\d+\]")),
    ("A внутренняя сноска", re.compile(r"【\d+†[^】]*】|sandbox:/mnt/data/")),
    ("A остаток размышлений", re.compile(r"</?think>")),
    ("A perplexity-upload", re.compile(r"ppl-ai-file-upload")),
    ("A placeholder", re.compile(r"INSERT_SOURCE_URL|PASTE_\w+_URL_HERE|\bURL_HERE\b|\b20\d\d-XX-XX\b")),
    ("A PUA-метка", re.compile(r"[-]")),
]
CODE_STRIP = re.compile(r"```.*?```|`[^`\n]+`", re.S)  # цитируемые артефакты не считаем
# Невидимые управляющие символы - класс B: они встречаются у CMS и рассылок,
# поэтому дают WARN. ZWJ внутри эмодзи-последовательности - норма.
EMOJI_CH = "[\U0001F000-\U0001FAFF☀-➿⬀-⯿️\U0001F3FB-\U0001F3FF]"
ZERO_WIDTH = re.compile(
    r"[\u00ad\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]"
    r"|(?<!%s)\u200d|\u200d(?!%s)" % (EMOJI_CH, EMOJI_CH),
)

# --- контекстные стилевые сигналы (номера паттернов из references/patterns.md) ---
STYLE_RULES = [
    ("23 длинное тире", re.compile(r"[—–]")),
    ("23 мат-знаки", re.compile(r"(?:[≈≥≤≠±⇒←→]|\s[=><&+]\s|\d\+(?!\d)|\bvs\.?\b)")),
    ("13 негативный параллелизм", re.compile(
        r"[Нн]е только\b[^.!?\n]{1,80}?\b(?:но|а)\s+\S|"
        r"[Нн]е просто (?!так\b)[^.!?\n]{1,80}?"
        r"(?:,\s*(?:а|но)\s+\S|(?:,|--?|—|–)\s*это\s+\S)|"
        r"[Нн]е просто (?!так\b)[^.!?\n]{1,40}[.!?]\s+Это\s+\S|"
        r"[Рр]ечь идёт не только|"
        r"[Нн]ет [^,.!?\n]{1,40}, нет ")),
    ("27 рубленый драматизм", re.compile(r"(?:Без|Ноль) [^.!?\n]{1,35}[.!] (?:Без|Ноль) ")),
]

# --- маркеры для судейского прохода (кластеры решают, не одиночные хиты) ---
WARN_PHRASES = [
    # 3 избегание «это»
    "представляет собой", "выступает в роли", "служит основой", "знаменует собой",
    # 6 AI-словарь (стемы ловят словоформы)
    "ключев", "важнейш", "знаменует", "демонстрир", "способств", "подчёркива",
    "свидетельств", "неуклонно",
    # 10 размытые атрибуции
    "по мнению экспертов", "аналитики отмечают", "исследователи утверждают",
    # 11 шаблонные переходы
    "важно отметить", "следует подчеркнуть", "необходимо учитывать",
    "стоит обратить внимание", "нельзя не упомянуть",
    # 12 вызовы и перспективы
    "сталкивается с рядом вызовов", "несмотря на эти вызовы",
    # 17-18 подобострастие и артефакты чатбота
    "отличный вопрос", "надеюсь, это поможет", "надеюсь, было полезно",
    "дайте знать", "буду рад помочь",
    # 20 позитивные заключения
    "будущее выглядит ярким", "впереди захватывающие времена", "продолжает процветать",
    # 22 стоп-слова
    "в современном мире", "на сегодняшний день", "в настоящее время", "как известно",
    "не секрет, что", "ни для кого не секрет", "каждый из нас",
    # 25 псевдоглубина (+ faux-insight сетапы)
    "по сути", "если копнуть глубже", "глубинная проблема", "настоящий вопрос в том",
    "в конечном счёте", "все упускают", "большинство упускает", "никто не расскажет",
    "никто не говорит о", "главная ошибка большинства", "чего вам не расскажут",
    # 26 анонсы
    "давайте разберёмся", "погрузимся в", "вот что нужно знать", "без лишних слов",
    # 29 фальшивая доверительность
    "скажу прямо", "давайте начистоту", "вот в чём штука", "если по-честному",
    # 37 псевдо-терапевтический регистр
    "и это нормально", "и это окей", "вы не одиноки", "давайте признаем",
    "позвольте себе",
    # 31 резюме
    "подводя итог", "в заключение", "резюмируя",
    # 32 спекуляции
    "широко не задокументирован", "предположительно",
    # 34 стопка абзацев (фразы-склейки без связи)
    "кроме того", "более того", "также стоит", "ещё один аспект", "ещё одним",
]
# 19: три и более смягчения в одном предложении = каскад (одно-два - норма речи)
SOFTENERS = ("возможно", "вероятно", "по-видимому", "как правило", "в некоторых случаях",
             "скорее всего", "при определённых условиях", "обычно", "в зависимости от",
             "в большинстве случаев", "потенциально")
# colon reveal: «подводка: драматичное раскрытие» - только явные формы,
# чтобы не бить по спискам, меткам и обычным двоеточиям
COLON_REVEAL = re.compile(
    r"(?:[Сс]амое (?:интересное|главное|важное)|[Лл]учшая часть|[Гг]лавная деталь|"
    r"[Фф]ишка в том|[Дд]еталь, которая [^:\n]{0,35})\s*:")
VERB_WORD = re.compile(r"\b[а-яё]+(?:ует|яет|ает|еет|ит|ат|ят|ют|ал|ял|ил|ел)\b", re.I)

STRIP = re.compile(r"```.*?```|`[^`\n]+`|https?://\S+", re.S)  # код и URL не проза


def strip_frontmatter(lines):
    if lines and lines[0].strip() == "---":
        for i in range(1, min(len(lines), 40)):
            if lines[i].strip() == "---":
                return [""] * (i + 1) + lines[i + 1:]
    return lines

def is_prose_line(line):
    return bool(line.strip()) and not re.match(r"^\s*(#|\||[-*+]\s|\d+\.\s|>|`{3}|-{3,}|\*{3}|_{3,})", line)


def sentences(text):
    text = re.sub(r"\*\*|«|»", "", text)
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]


def prose_paragraphs(lines):
    paragraphs = []
    current = []
    for line in lines:
        if is_prose_line(line):
            current.append(line.strip())
        elif current:
            paragraphs.append(" ".join(current))
            current = []
    if current:
        paragraphs.append(" ".join(current))
    return paragraphs


def prose_sentences(lines):
    return [sentence for paragraph in prose_paragraphs(lines) for sentence in sentences(paragraph)]


def verb_words(sentence):
    return set(VERB_WORD.findall(sentence.lower()))


def lint(text, *, formal=False):
    findings = []  # (kind, line_no, rule, excerpt)
    text = text.lstrip("﻿")  # BOM - артефакт кодировки, не текста

    # класс A: по сырому тексту (URL нужны для utm/referrer), но без бэктиков
    raw = CODE_STRIP.sub(lambda m: "\n" * m.group(0).count("\n"), text)
    for i, line in enumerate(strip_frontmatter(raw.splitlines()), 1):
        for rule, rx in ARTIFACTS:
            for m in rx.finditer(line):
                ctx = line[max(0, m.start() - 25):m.end() + 25].strip()
                findings.append(("ERROR", i, rule, ctx))
        if ZERO_WIDTH.search(line):
            findings.append(("WARN", i, "B символ нулевой ширины",
                             "невидимый символ (CMS и рассылки тоже их ставят - проверь источник)"))

    clean = STRIP.sub(lambda m: "\n" * m.group(0).count("\n"), text)
    lines = strip_frontmatter(clean.splitlines())

    for i, line in enumerate(lines, 1):
        scan = re.sub(r"^\s*[>+*]\s", "  ", line)  # markdown-маркеры не прозаические знаки
        if not formal:
            for rule, rx in STYLE_RULES:
                for m in rx.finditer(scan):
                    ctx = scan[max(0, m.start() - 25):m.end() + 25].strip()
                    findings.append(("WARN", i, rule, ctx))
        low = scan.lower()
        for phrase in WARN_PHRASES:
            if phrase in low:
                findings.append(("WARN", i, phrase, scan.strip()[:70]))
        if COLON_REVEAL.search(scan):
            findings.append(("WARN", i, "двоеточие-подводка", scan.strip()[:70]))

    sents = prose_sentences(lines)
    lengths = [len(s.split()) for s in sents]

    # 19: каскад смягчений - три и более уклончивых слова в одном предложении
    for s in sents:
        low = s.lower()
        hits = sum(low.count(w) for w in SOFTENERS)
        if hits >= 3:
            findings.append(("WARN", 0, "19 каскад смягчений", f"{hits} смягчения: {s[:60]}"))

    # 33: точный повтор глагола в соседних предложениях одного абзаца
    for paragraph in prose_paragraphs(lines):
        paragraph_sentences = sentences(paragraph)
        for first, second in zip(paragraph_sentences, paragraph_sentences[1:]):
            common = verb_words(first) & verb_words(second)
            if common:
                findings.append(("WARN", 0, "33 точный повтор глагола",
                                 f"«{sorted(common)[0]}» в соседних предложениях: {second[:50]}"))

    # ритм (burstiness): монотонность и отсутствие коротких предложений
    if len(lengths) >= 8:
        diffs = [abs(x - y) for x, y in zip(lengths, lengths[1:])]
        mean_diff = sum(diffs) / len(diffs)
        if mean_diff < 4:
            findings.append(("WARN", 0, "ритм монотонный",
                             f"средняя разница длин соседних предложений {mean_diff:.1f} слова (живой текст: 6+)"))
        if len(lengths) >= 10 and not any(l <= 8 for l in lengths):
            findings.append(("WARN", 0, "ритм без коротких",
                             "ни одного предложения до 8 слов - нет пауз и акцентов"))


    return findings


def verdict(errors, warnings):
    score = errors * 3 + warnings
    if score <= 3 and errors == 0:
        return score, "clean"
    if score <= 10:
        return score, "review - исправь errors" if errors else "review - посмотри warnings кластерами"
    return score, "rewrite - слопа слишком много для точечных правок"


def self_test():
    style = "Это не просто курс — это экосистема. Скорость > идеальности. Без кода. Без настроек. Итог ≈ 5+ часов, джуны vs сеньоры."
    kinds = [f[2] for f in lint(style) if f[0] == "WARN"]
    assert any("13" in k for k in kinds), kinds
    assert any("тире" in k for k in kinds), kinds
    assert any("мат-знаки" in k for k in kinds), kinds
    assert any("27" in k for k in kinds), kinds
    assert not [f for f in lint(style) if f[0] == "ERROR"], lint(style)

    formal = "Точная цитата «Срок — 30 дней». В формуле x ≥ 0 используется обязательная нотация."
    assert not [f for f in lint(formal, formal=True) if f[2].startswith("23 ")], lint(formal, formal=True)

    ok = "Обычный текст - с коротким тире, без слопа. Цифры 12 и 87 на месте.\n> цитата\n+ пункт списка"
    assert not [f for f in lint(ok) if f[0] == "ERROR"], lint(ok)

    warn = "Важно отметить, что по сути будущее выглядит ярким."
    assert len([f for f in lint(warn) if f[0] == "WARN"]) >= 3

    markdown = "## Решение\n\n**Вывод:** оставить структуру.\n\n---\n\n| Вариант | Решение |\n|---|---|\n| A | Взять |"
    assert not [f for f in lint(markdown) if "разделитель" in f[2] or "эмодзи" in f[2]], lint(markdown)

    verbs = "Сбербанк предлагает проверять адрес каждого перевода внимательно. Тинькофф предлагает подтверждать операцию отдельным кодом всегда."
    assert any("33" in f[2] for f in lint(verbs)), lint(verbs)

    mono = " ".join(["Это предложение содержит ровно семь слов подряд." ] * 12)
    assert any("ритм" in f[2] for f in lint(mono)), lint(mono)

    # класс A: артефакты копипаста ловятся, в том числе внутри URL
    art = ("Рынок вырос :contentReference[oaicite:0]{index=0}, детали turn0search3, "
           "см. https://example.com/?utm_source=openai, sandbox:/mnt/data/result и [cite: 8].")
    kinds = [f[2] for f in lint(art) if f[0] == "ERROR"]
    assert any("contentReference" in k for k in kinds), kinds
    assert any("turn" in k for k in kinds), kinds
    assert any("utm" in k for k in kinds), kinds
    assert any("внутренняя" in k for k in kinds), kinds
    assert any("gemini" in k for k in kinds), kinds

    # артефакт в бэктиках - цитирование, не копипаст
    art_ok = "Статья разбирает метки `turn0search0` и `</think>` как признаки ИИ."
    assert not [f for f in lint(art_ok) if f[0] == "ERROR"], lint(art_ok)

    # ZWJ внутри эмодзи - норма; невидимые управляющие символы - WARN
    fam = "Семья 👨‍👩‍👧 поехала на дачу."
    assert not [f for f in lint(fam) if "нулевой ширины" in f[2]], lint(fam)
    zw = "Обычный текст с невидимым​символом внутри."
    assert any("нулевой ширины" in f[2] for f in lint(zw)), lint(zw)
    bidi = "Обычный текст с направлением\u202eвнутри."
    assert any("нулевой ширины" in f[2] for f in lint(bidi)), lint(bidi)

    # 19: каскад смягчений - три в одном предложении да, одно - нет
    soft = "Возможно, в некоторых случаях это, скорее всего, сработает."
    assert any("каскад" in f[2] for f in lint(soft)), lint(soft)
    soft_ok = "Возможно, это сработает."
    assert not [f for f in lint(soft_ok) if "каскад" in f[2]], lint(soft_ok)

    # двоеточие-подводка
    cr = "Самое интересное: агент учится сам."
    assert any("подводка" in f[2] for f in lint(cr)), lint(cr)
    cr_ok = "Список покупок: хлеб, молоко."
    assert not [f for f in lint(cr_ok) if "подводка" in f[2]], lint(cr_ok)

    print("self-test: OK")


def main():
    if "--self-test" in sys.argv:
        return self_test()
    formal = "--formal" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    text = open(args[0], encoding="utf-8").read() if args else sys.stdin.read()
    findings = lint(text, formal=formal)
    errors = [f for f in findings if f[0] == "ERROR"]
    warnings = [f for f in findings if f[0] == "WARN"]
    for kind, line_no, rule, ctx in findings:
        loc = f"строка {line_no}" if line_no else "текст"
        print(f"{kind} {loc}: [{rule}] {ctx}")
    score, v = verdict(len(errors), len(warnings))
    print(f"\nитого: {len(errors)} errors, {len(warnings)} warnings, severity {score} -> {v}")
    if errors:
        print("ГЕЙТ НЕ ПРОЙДЕН - текст не готов, чини errors и запускай снова.")
        sys.exit(1)
    print("гейт пройден: артефактов копипаста не найдено.")


if __name__ == "__main__":
    main()
