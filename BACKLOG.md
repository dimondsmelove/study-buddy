# Study Buddy — статус, бэклог и проработка промптов

Единый источник правды по всем предложенным пунктам и их статусу.
Легенда: ✅ сделано · 🟡 частично · ⬜ предложено, не начато · ❌ отклонено решением.

_Обновлено: 2026-10-05 · последний коммит `07f006f` (этот файл — поверх него)._

Рабочий режим: **одна итерация = одна спека → реализация → показ скринов →
обновление статуса здесь**. Без прыжков между срезами.

---

## 1. Что сделано

| Область | Что | Где |
|---|---|---|
| Захват | overlay → `captureVisibleTab` → кроп → `storage.session` → панель; permission/restricted флоу | `src/content/overlay.ts`, `src/background/*` |
| Задачи | **Solve, Quiz, Explain, Translate, Summarize + Ask** — структурированные ответы | `src/chat/chat.ts` (`presetPrompts`) |
| Диалог | свободный вопрос, контекст сохраняется между захватами | `chat.ts` (`history`) |
| Ответы | **Markdown + LaTeX (KaTeX)**, код, copy / retry / «проще» | `chat.ts`, `chat.css` |
| Модель | DeepSeek + авто-фолбэк (Gemini 2.5 Flash Lite → GPT-5 Nano); типизированные ошибки (`ApiError`) | `src/shared/ai.ts`, `api.ts` |
| Ключ | зашит в сборку (`SB_DEFAULT_API_KEY`), онбординга нет; свой ключ — под «Advanced» | `src/shared/config.ts`, `vite.config.ts` |
| Шов под подписку | `Gateway` — единая точка вызова модели | `src/shared/gateway.ts` |
| Языки | интерфейс RU/EN + язык ответов (Auto / ru / en / …) | `src/shared/i18n.ts`, `settings.ts` |
| Полировка | «Новое выделение», локализованные состояния, фолбэк-заметка; кроп — миниатюра + лайтбокс по клику | `chat.ts/html/css` |
| Тесты | `verify` 16/16, `quality` (реальный API), `compare`, `playtest`, `review` | `scripts/*` |
| Панель | ресайз (drag за угол, размер запоминается), дефолт 480×600, компактные SVG-кнопки действий | `src/content/overlay.ts`, `chat.ts`, `chat.css` |
| Магазин | `store/listing.md`, `store/privacy.md`, 4 скриншота 1280×800 | `store/` |
| Процесс | этот трекер | `BACKLOG.md` |

---

## 2. Предложено, но не сделано

### 2.1 Задачи-интенты

| # | Задача | Статус | Примечание |
|---|---|---|---|
| 1 | Hint / Socratic — подсказка без готового ответа | ⬜ | анти-читинг, педагогически ценно |
| 2 | Check my work — проверка своего решения | ⬜ | |
| 3 | Simplify / ELI5 как задача | 🟡 | есть «Проще» как действие над ответом, нет кнопки задачи |
| 4 | Glossary — определения/формулы/даты | ⬜ | |
| 5 | Read the visual — график/схема/таблица | ⬜ | |
| 6 | Practice more — похожие задачи с ростом сложности | ⬜ | |
| 7 | Flashcards — карточки Q/A | ⬜ | |
| 8 | Study plan / exam cram | ⬜ | |
| 9 | Teach me — мини-урок | ⬜ | |
| 10 | Concept map — карта понятий | ⬜ | |
| 11 | Essay feedback — по рубрике | ⬜ | |
| 12 | Rewrite — грамматика/стиль | ⬜ | |
| 13 | Vocabulary — слова/идиомы | ⬜ | |
| 14 | Outline — план эссе/ответа | ⬜ | |
| 15 | Read aloud (TTS) | ⬜ | доступность |
| 16 | History / review mistakes | ⬜ | |
| 17 | Multi-snippet — несколько выделений | ⬜ | |
| 18 | Авто-определение формата (MCQ/эссе/лабораторная/код/источник) | 🟡 | только Quiz вручную |
| 19 | Subject-aware системный промпт (математика/история/код) | ⬜ | |
| 20 | Категории/группировка задач | ⬜ | без этого каталог не масштабируется |

### 2.2 UI/UX

| # | Пункт | Статус |
|---|---|---|
| 21 | Категории/табы задач | ⬜ |
| 22 | SVG-иконки вместо текста/эмодзи | 🟡 (кнопки действий — SVG; пресеты задач — текст) |
| 23 | Скелетон-загрузка и курсор стрима | 🟡 (сейчас «…») |
| 24 | Тёмная тема | ⬜ |
| 25 | Ресайз панели + запоминание позиции | ✅ (ресайз за угол + размер сохраняются; позиция якорится у выделения по дизайну) |
| 26 | Быстрый тулбар у выделения | ⬜ |
| 27 | Разворот в Chrome Side Panel | ⬜ |
| 28 | История ответов | ⬜ |
| 29 | First-run подсказка «Ctrl+Shift+Y» | ⬜ |
| 30 | Accessibility-проход | 🟡 |

### 2.3 Архитектура / безопасность

| # | Пункт | Статус |
|---|---|---|
| 31 | Hosted-прокси (подписка, квоты, ключ на сервере) | ⬜ (шов готов) |
| 32 | Защита зашитого ключа: `max_tokens`, мягкие rate-limit'ы | ⬜ |

### 2.4 Магазин

| # | Пункт | Статус |
|---|---|---|
| 33 | Промо-плитка 440×280 | ⬜ |
| 34 | Финальное имя (проверить конфликты) | ⬜ |
| 35 | Публичный URL privacy-политики + реальный email | ⬜ |
| 36 | Форма CWS: категория, язык, обоснование прав | ⬜ |

---

## 3. Отклонено решением (сознательно)

- ❌ Онбординг с ключом — убран, ключ зашит.
- ❌ Пользовательский выбор модели — фиксирован DeepSeek.
- 🗑️ Model picker (Phase 1-B) — был сделан и удалён по решению; `src/shared/models.ts` оставлен «на будущее».

---

## 4. Чего не предлагалось, но нужно

- Стабильность ответов: нет `max_tokens`, нет ретраев на таймаут/обрыв, нет защиты от зацикливания.
- Стоимость: при общем ключе нет учёта расходов и квот на пользователя.
- Метрики: непонятно, какие задачи реально жмут (хотя бы локальный счётчик).
- Онбординг-замена: одна подсказка при первом запуске.

---

## 5. ПРОМПТЫ: что улетает модели сейчас и что нужно проработать

> Отдельный рабочий пункт. Цель — по каждому варианту действий (и по свободному
> вопросу) иметь **спецификацию промпта**: точный текст, структура вывода, язык,
> ограничения, эталонный ответ. Менять промпты — правкой данных/констант, не логики.

### 5.1 Как собирается запрос сейчас

Состав сообщений на каждый вызов:

```
[
  { role: "system",  content: <systemPrompt()> },
  ...history,                       // прошлые user/assistant ходы (картинки в них сохраняются)
  { role: "user", content: [
      { type: "text", text: <промпт задачи или вопрос пользователя> },
      { type: "image_url", image_url: { url: <data:image/png;base64,… > } }   // текущий кроп
  ]}
]
```

Параметры запроса: `model`, `stream: true`, `X-Title: Study Buddy`.
**Нет** `max_tokens`, `temperature`, `reasoning_effort` — всё на дефолтах провайдера.

### 5.2 Текущий системный промпт (as-is)

```
You are Study Buddy, a concise and friendly tutor. The user shares a screenshot
of part of their screen and asks about what is visible. Solve or explain exercises
and translate text. Ground every answer in the image; if something is unreadable
or not present, say so instead of guessing. Format answers in Markdown; use LaTeX
for math ($...$ inline, $$...$$ display).

Language: answer in the language the user writes in. For the app's fixed actions
(which carry no prose of their own), answer in <target>. If the user explicitly
asks to answer in, or translate into, a particular language, follow that.
```

При явно выбранном языке ответа второй абзац заменяется на:
`Language: always answer in <target>, unless the user explicitly asks for another language.`

### 5.3 Текущие промпты задач (as-is)

| Задача | Промпт, который уходит (плейсхолдер `<lang>` — язык ответа) |
|---|---|
| **Solve** | `Solve the problem shown in the image. Reply in this exact structure:\n1) Answer: ...\n2) Steps: ...\n3) Check / common mistakes: ...\nWrite in <lang>.` |
| **Quiz** | `This is a multiple-choice question. Reply in this structure:\n1) Correct option: ...\n2) Why it is correct: ...\n3) Why each other option is wrong: ...\nWrite in <lang>.` |
| **Explain** | `Explain what is shown to a student. Reply in this structure:\n1) In one sentence: ...\n2) Step by step: ...\n3) Key terms: ...\nWrite in <lang>.` |
| **Translate** | `Translate all the text in the image into <lang>. If it is already in <lang>, translate it into English instead. Output the translation only — do not restate the original text.` |
| **Summarize** | `Summarize what is shown in 3-5 key points.\nWrite in <lang>.` |
| **«Проще»** (действие) | `Explain your previous answer in simpler terms, more briefly, with a concrete example if helpful. Write in <lang>.` |
| **Ask** | (промпта нет — уходит вопрос пользователя как есть) |

### 5.4 Что нужно проработать (чек-лист работ)

- [ ] **Шаблон спеки на каждый вариант.** Задача → цель → вход (что на картинке) →
      структура вывода → язык → тон → ограничения (длина, токены) → 1–2 примера good → анти-пример.
- [ ] **Ревизия system prompt:** роль, «опирайся только на картинку», анти-галлюцинации,
      Markdown/LaTeX, правила языка, запрет выдумывать невидимое.
- [ ] **Промпты для новых задач:** Hint, Check my work, Simplify(как задача), Glossary,
      Read the visual, Practice more, Flashcards, Study plan, Teach me, Concept map,
      Essay feedback, Rewrite, Vocabulary, Outline.
- [ ] **Отдельный промпт для Hint:** не давать ответ, задать один наводящий вопрос +
      одну подсказку, ждать попытку студента (Socratic).
- [ ] **Языковая логика:** auto vs явный выбор; пресеты = язык интерфейса;
      «переведи на X» перебивает всё; проверить на RU/EN/DE.
- [ ] **Управление длиной:** ввести `max_tokens` и/или инструкции по лаконичности;
      отдельно — бюджет reasoning-моделей (DeepSeek/GPT-5 Nano).
- [ ] **Авто-определение формата:** MCQ / short answer / эссе / лабораторная / код /
      анализ источника — чтобы задача вела себя правильно без ручного выбора.
- [ ] **Subject-aware слой:** подсказки для математики (LaTeX, проверка), истории (даты,
      причинно-следствия), языка (грамматика), кода (объяснение/отладка).
- [ ] **Few-shot / negative instructions** там, где модель стабильно ошибается
      (формат, «не пересказывай оригинал», «не выдумывай»).
- [ ] **Версионирование:** все тексты промптов — в одном модуле-константе, с датой/версией,
      чтобы ревизия не требовала правок логики.
- [ ] **Ревью качества:** прогнать `npm run quality` и `npm run compare` по каждому промпту,
      сохранить эталонные ответы (до/после) и зафиксировать в отчёте.
- [ ] **Регресс-тест промптов:** проверка, что для каждой задачи уходит ожидаемый текст
      (unit-уровень, без реального API).

### 5.5 Шаблон спеки промпта (черновик формы)

```
Задача:            <Solve / Hint / …>
Цель:              <что должен получить студент>
Вход:              <что обычно на кропе; что делать, если нечитаемо/пусто>
Вывод (структура): <ровно какие секции и в каком порядке>
Язык:              <правило>
Тон/длина:         <кратко/подробно; ограничение>
Ограничения:       <не выдумывать; опираться на изображение; max_tokens>
Пример good:       <…>
Анти-пример:       <…>
```

---

## 6. Предлагаемый порядок работ

1. **Каталог задач:** категории + Hint + Check my work + Simplify/Glossary/Read the visual.
2. **Практика:** Practice more + Flashcards + Study plan.
3. **Редизайн панели:** категории/табы, SVG-иконки, skeleton, тёмная тема, ресайз.
4. **Промпты:** ревизия system prompt + spec на каждую задачу + регресс-тест (§5).
5. **Умный промпт:** subject-aware + авто-определение формата.
6. **Сессии:** история, тулбар у выделения, side panel.
7. **До магазина:** защита ключа (лимиты) + прокси, промо-плитка, имя, privacy URL.

## 7. Как работаем

- Перед срезом — короткая спека (что/зачем/как выглядит/точки ревью).
- Один срез — один коммит; после — `npm run review` и показ скринов.
- После каждого среза обновляется этот файл (статусы в §1–§4, промпты в §5).
- Код не трогаем, пока срез не подтверждён.
