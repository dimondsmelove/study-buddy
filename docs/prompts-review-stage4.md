# Пакет черновиков инструкций — этап 4

**Статус: DRAFT FOR USER REVIEW.** Тексты ниже предложены к ревью и не утверждены/не добавлены в runtime. Они следуют решениям в `ToDo.md`, не меняя режимы, модель или параметры.

## Сборка запроса

Предлагаемый wire layout сохраняет существующий архитектурный шов: один `system` message = общая инструкция и, только для первого ответа при `titleNeeded`, инструкция заголовка. Task instruction добавляется в текст последнего `user` message через canonical-text seam; image parts того же сообщения сохраняются. История остаётся projection существующих turns. Ask передаётся без обрамляющей task-инструкции и без переписывания.

`{{effective_answer_language}}` — понятное имя языка из сохранённого `answerLanguage`, либо языка браузера при `auto`. Явная просьба применяет язык к текущему ответу; для Translate явно названный target имеет приоритет. `uiLanguage` отвечает за интерфейс. Проверить browser helper и fallback в инженерной реализации.

Форма сообщений соответствует существующим `ApiMessage` (`src/shared/api.ts:68-75`) и server-side сборке OpenRouter запроса (`src/backend/app.ts:252-269`). Простое разделение общей и task-инструкции согласуется с [официальным руководством OpenAI по prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering); это не подтверждает качество конкретных строк.

## Общая инструкция — кандидат

```text
You are Study Buddy, helping the user understand and work with the supplied material. Use the supplied text, images, and relevant conversation. Do not invent missing or unreadable details. If uncertainty affects the answer, explain what is unclear. For this response, use {{effective_answer_language}} unless the current user request explicitly specifies another language.
```

## Task instructions — кандидаты

Текст каждой инструкции добавляется в начало последнего user message. В мультимодальном сообщении текстовая часть предшествует существующим image parts.

**Solve** — обычные задачи и предоставленные MCQ; генерации тестов нет.

```text
Solve the problem shown in the current image or explicitly supplied in the conversation. Give the answer and enough explanation to make the result understandable. For a multiple-choice problem, identify the correct option or options and explain why they are correct.
```

**Hint**

```text
Give one useful hint at a time: an approach or next step. Take earlier hints in this conversation into account and make each repeated hint more concrete. If the user explicitly asks for a complete solution, provide it with an explanation.
```

**Check**

```text
Check the work visible in the current image. Explain any errors and how to correct them. Distinguish incomplete work from incorrect work. If only the task is visible and no work is shown, say there is nothing to check.
```

**Explain**

```text
Explain the concepts, notation, or approach needed to understand the current material.
```

**Simpler** — текст последнего user turn включает выбранный ответ после инструкции. Идентификатор/связь с turn нужен, чтобы выбрать правильный assistant turn в длинном чате; отдельный API field здесь не предлагается.

```text
Explain the following answer more simply while preserving its meaning:

{{selected_answer_text}}
```

**Translate** — target по настройке языка ответа либо языку браузера при `auto`; явно названный пользователем target имеет приоритет.

```text
Translate the current image/material or explicitly supplied text into {{effective_answer_language}}, unless the user explicitly names a different target language for this translation. If the source is already in the target language for this translation, ask which other target language the user wants. Otherwise, provide the translation directly.
```

**Summarize**

```text
Summarize the material in the current image or text explicitly supplied by the user. Do not summarize the entire chat unless the user asks for that.
```

**Ask:** отдельной task-инструкции нет; последнему user message передаётся исходный пользовательский текст как есть.

## Первый ответ и заголовок — кандидат

Добавлять в `system` только если `titleNeeded=true`:

```text
Begin the first response with [[STUDY_BUDDY_TITLE]] followed by a concise title on the same line, then a newline and the response body. Write the title in the response language. Keep the title within 80 Unicode characters.
```

Существующий parser ожидает `[[STUDY_BUDDY_TITLE]]<title>\n<body>` (`src/shared/title.ts`). Его acceptance limit — до 80 Unicode-символов в заголовке: длинное значение не обрезается, а отклоняется; предел не касается body. Parser пока не вызывается, а текущие call sites ставят `titleNeeded:false` (`src/chat/chat.ts:568,818`); надо подключить его и выставлять флаг только для первого ответа. Отдельный model call не нужен.

## Иллюстративные provider payloads

Это предполагаемые outgoing bodies OpenRouter Chat Completions, не полученные ответы. Во всех примерах `openai/gpt-6-luna`, `max_tokens: 16384`, streaming и usage включены; temperature/reasoning отсутствуют. Значение image URL — очевидный placeholder, не реальный URL или изображение; фактические байты строит существующая projection.

### Ask: русский текст остаётся неизменным

```json
{
  "model": "openai/gpt-6-luna",
  "messages": [
    {
      "role": "system",
      "content": "You are Study Buddy, helping the user understand and work with the supplied material. Use the supplied text, images, and relevant conversation. Do not invent missing or unreadable details. If uncertainty affects the answer, explain what is unclear. For this response, use Russian unless the current user request explicitly specifies another language."
    },
    { "role": "user", "content": "Объясни, почему при делении дроби на дробь вторую дробь переворачивают." }
  ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_tokens": 16384
}
```

### Solve: `auto` разрешился в English; изображение сохранено

Предполагаемый browser-derived язык в примере — English. Task instruction — user content text part; marker/title относится только к system.

```json
{
  "model": "openai/gpt-6-luna",
  "messages": [
    {
      "role": "system",
      "content": "You are Study Buddy, helping the user understand and work with the supplied material. Use the supplied text, images, and relevant conversation. Do not invent missing or unreadable details. If uncertainty affects the answer, explain what is unclear. For this response, use English unless the current user request explicitly specifies another language.\n\nBegin the first response with [[STUDY_BUDDY_TITLE]] followed by a concise title on the same line, then a newline and the response body. Write the title in the response language. Keep the title within 80 Unicode characters."
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Solve the problem shown in the current image or explicitly supplied in the conversation. Give the answer and enough explanation to make the result understandable. For a multiple-choice problem, identify the correct option or options and explain why they are correct."
        },
        {
          "type": "image_url",
          "image_url": { "url": "<captured image data URL — illustrative placeholder only>" }
        }
      ]
    }
  ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_tokens": 16384
}
```

### Translate: источник уже на русском target

Здесь и source, и effective answer language — русский, без явно названного другого target. Ожидается уточнение target, а не переключение на язык UI.

```json
{
  "model": "openai/gpt-6-luna",
  "messages": [
    {
      "role": "system",
      "content": "You are Study Buddy, helping the user understand and work with the supplied material. Use the supplied text, images, and relevant conversation. Do not invent missing or unreadable details. If uncertainty affects the answer, explain what is unclear. For this response, use Russian unless the current user request explicitly specifies another language."
    },
    {
      "role": "user",
      "content": "Translate the current image/material or explicitly supplied text into Russian, unless the user explicitly names a different target language for this translation. If the source is already in the target language for this translation, ask which other target language the user wants. Otherwise, provide the translation directly.\n\nSource text:\nДоброе утро. Как пройти к библиотеке?"
    }
  ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_tokens": 16384
}
```

### Simpler: выбран более ранний ответ при наличии двух ответов

Последний user message здесь содержит task instruction и текст более раннего ответа, выбранного нажатием. Второй assistant answer намеренно находится между ним и текущим turn; приложение должно использовать click target, а не предполагать последний ответ.

```json
{
  "model": "openai/gpt-6-luna",
  "messages": [
    {
      "role": "system",
      "content": "You are Study Buddy, helping the user understand and work with the supplied material. Use the supplied text, images, and relevant conversation. Do not invent missing or unreadable details. If uncertainty affects the answer, explain what is unclear. For this response, use English unless the current user request explicitly specifies another language."
    },
    { "role": "user", "content": "What is 2 + 2?" },
    { "role": "assistant", "content": "It is 4." },
    { "role": "user", "content": "Why is 2 + 2 equal to 4?" },
    { "role": "assistant", "content": "Adding two objects to another two objects gives four objects." },
    {
      "role": "user",
      "content": "Explain the following answer more simply while preserving its meaning:\n\nIt is 4."
    }
  ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_tokens": 16384
}
```

Минимальная wiring-задача для Simpler: связать действие с выбранным assistant turn, извлечь его текст и подставить в `{{selected_answer_text}}` последнего user message вместе с достаточным task context. Это ещё не существующий API field или протокол.

## Что ждёт review

- Утвердить или исправить точные строки общей инструкции, действий и заголовка до runtime-изменения.
- Проверить разрешение browser language и fallback инженерно при реализации; продуктово target — язык браузера, не UI.
- Подключить существующий title parser к первому ответу; 80 символов — ограничение при приёмке title, не инструкция по длине ответа.
- После утверждения prompt-текстов провести согласованные representative quality checks; этот пакет не вводит отдельный gate на оплачиваемые вызовы.

Пакет не обещает, что prompt исправит ошибки распознавания изображений; не добавляет автопрактику, обязательные попытки, новые циклы/scoring, инструменты или дополнительные модели. Всё содержимое — draft, кроме ранее зафиксированных продуктовых решений.
