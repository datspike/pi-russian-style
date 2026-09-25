export const RUSSIAN_STYLE_PROMPT_MARKER = "<!-- russian-style -->";
export const RUSSIAN_STYLE_PROMPT_END_MARKER = "<!-- /russian-style -->";

export const RUSSIAN_STYLE_PROMPT = `Пиши естественным русским техническим языком: ясно, прямо и без канцелярита или служебных вступлений. Используй обычные русские слова вместо лишних англицизмов, но уважай явно выбранный пользователем язык. Код, команды, пути, API, идентификаторы, названия продуктов и дословные сообщения сохраняй точно.
В объяснениях и отчётах не подменяй действие или состояние цепочкой служебных терминов. Если замена отдельных английских слов русскими не делает фразу понятнее читателю, перестрой её: назови действие или состояние и его предмет. Сохраняй точные технические имена, факты и существенные оговорки; недостающие сведения не додумывай. Уже понятную фразу не усложняй пояснениями.`;

const ENGLISH_RESPONSE = "(?:на английском(?: языке)?|по-английски)";
const ENGLISH_ACTION = "(?:answer|respond|write|reply|provide|give)";
const ENGLISH_OBJECT = "(?:(?:the|an?)\\s+)?(?:answer|response|text|version)?";

const ENGLISH_REQUEST_PATTERNS = [
  new RegExp(
    `(?:^|[.!?]\\s*)(?:пожалуйста[,:]?\\s*)?` +
      `(?:ответь|отвечай|пиши|напиши|говори|скажи|сформулируй|подготовь(?:\\s+(?:ответ|текст|версию))?)` +
      `[^.!?\\n]{0,48}${ENGLISH_RESPONSE}`,
    "i",
  ),
  new RegExp(
    `(?:можешь|можно|прошу)\\s+(?:мне\\s+)?` +
      `(?:ответить|написать|сформулировать|подготовить)[^.!?\\n]{0,48}${ENGLISH_RESPONSE}`,
    "i",
  ),
  new RegExp(`(?:мне\\s+)?(?:нужен\\s+ответ|нужен\\s+текст|нужна\\s+версия)[^.!?\\n]{0,24}${ENGLISH_RESPONSE}`, "i"),
  new RegExp(`(?:^|[.!?]\\s*)(?:переведи|перевести|перевод)[^.!?\\n]{0,48}на английский(?: язык)?`, "i"),
  new RegExp(`^\\s*${ENGLISH_RESPONSE}(?:\\s*,?\\s*пожалуйста)?[.!]?\\s*$`, "i"),
  /(?:^|[.!?]\s*)(?:оставь|сделай|подготовь)\s+(?:только\s+)?(?:английский|англоязычный)\s+(?:вариант|ответ|текст)/i,
  /(?:^|[.!?]\s*)(?:только|лишь)\s+(?:английский|англоязычный)\s+(?:вариант|ответ|текст)/i,
  new RegExp(`(?:^|[.!?]\\s*)(?:please\\s+)?${ENGLISH_ACTION}\\s+${ENGLISH_OBJECT}\\s*(?:to me\\s+)?in\\s+English\\b`, "i"),
  new RegExp(`\\b(?:can|could|would)\\s+you\\s+(?:please\\s+)?${ENGLISH_ACTION}\\s+${ENGLISH_OBJECT}\\s*(?:to me\\s+)?in\\s+English\\b`, "i"),
  new RegExp(`^\\s*I\\s+(?:want|need|would like)\\s+(?:(?:you\\s+to\\s+)?${ENGLISH_ACTION}\\s+)?${ENGLISH_OBJECT}\\s*in\\s+English\\b`, "i"),
  /^\s*(?:please\s+)?translate\b[^.!?\n]{0,64}\b(?:into|to)\s+English\b/i,
  /^\s*in\s+English(?:\s*,?\s*please)?[.!]?\s*$/i,
  /^\s*English(?:\s*,?\s*please|\s+only)[.!]?\s*$/i,
  /(?:^|[.!?]\s*)(?:keep|use)\s+(?:only\s+)?English(?:\s*,?\s*please)?[.!]?\s*$/i,
];

const ENGLISH_NEGATION_PATTERNS = [
  new RegExp(
    `не\\s+(?:отвечай|ответь|пиши|напиши|говори|скажи|переводи|сформулируй)` +
      `[^.!?\\n]{0,40}${ENGLISH_RESPONSE}`,
    "i",
  ),
  new RegExp(
    `не\\s+(?:надо|нужно|следует|стоит)\\s+(?:мне\\s+)?` +
      `(?:отвечать|писать|говорить|переводить|формулировать)[^.!?\\n]{0,40}${ENGLISH_RESPONSE}`,
    "i",
  ),
  new RegExp(`(?:ответь|пиши|напиши|говори)\\s+не\\s+${ENGLISH_RESPONSE}`, "i"),
  /\b(?:please\s+)?(?:do not|don't|dont|never)\s+(?:answer|respond|write|reply|provide|give)\b[^.!?\n]{0,48}\bin\s+English\b/i,
  /\bI\s+(?:do not|don't|dont)\s+want\s+(?:you\s+)?to\s+(?:answer|respond|write|reply|provide|give)\b[^.!?\n]{0,48}\bin\s+English\b/i,
  /\b(?:answer|respond|write|reply|provide|give)\b[^.!?\n]{0,48}\bnot\s+in\s+English\b/i,
];

const ENGLISH_MENTION_PATTERNS = [
  /\b(?:answer|respond|write|reply|provide|give)\b[^.!?\n]{0,32}\bin\s+English\b\s*(?:—|-|:)\s*(?:это|означает|название|заголовок|пример|имя|команда|режим)/i,
  /\b(?:answer|respond|write|reply|provide|give)\b[^.!?\n]{0,32}\bin\s+English\b\s+(?:это|означает|название|заголовок|пример|имя|команда|режим)/i,
  /\b(?:answer|respond|write|reply|provide|give)\b[^.!?\n]{0,32}\bin\s+English\b[^.!?\n]{0,24}\b(?:is|means|names|denotes)\b/i,
];

function stripQuotedMentions(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/«[^»\n]*»/g, " ")
    .replace(/“[^”\n]*”/g, " ")
    .replace(/‘[^’\n]*’/g, " ")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/'[^'\n]*'/g, " ");
}

/** Возвращает true только для явной просьбы вести ответ на английском. */
export function isExplicitEnglishRequest(text: string): boolean {
  const request = stripQuotedMentions(text);
  if (ENGLISH_NEGATION_PATTERNS.some((pattern) => pattern.test(request))) return false;
  if (ENGLISH_MENTION_PATTERNS.some((pattern) => pattern.test(request))) return false;
  return ENGLISH_REQUEST_PATTERNS.some((pattern) => pattern.test(request));
}

/** Добавляет контракт русского стиля ровно один раз и не трогает уже знакомые маркеры. */
export function applyRussianStylePrompt(systemPrompt: string, requestText: string, enabled: boolean): string {
  if (!enabled || isExplicitEnglishRequest(requestText) || systemPrompt.includes(RUSSIAN_STYLE_PROMPT_MARKER)) {
    return systemPrompt;
  }
  return `${systemPrompt}\n\n${RUSSIAN_STYLE_PROMPT_MARKER}\n${RUSSIAN_STYLE_PROMPT}\n${RUSSIAN_STYLE_PROMPT_END_MARKER}`;
}
