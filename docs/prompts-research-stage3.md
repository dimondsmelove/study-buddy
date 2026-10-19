# Study Buddy — stage 3: текущие tutor flows и evidence

Проверено 2026-10-19 на `88680fd60d6cf07a364ee62ed83ad7024be08d0c` (`work/study-buddy-luna-prompts-2026-10-19`). Это code-based карта, не визуальная приёмка UI. Решения в разделе рекомендаций — HYPOTHESIS/OPEN.

## Вывод по текущему поведению

**FACT.** В этом срезе кнопки и `Turn.kind` сохранились, но app-generated текстовые инструкции пусты (`src/shared/prompts/index.ts:19-37`). Gateway task metadata содержит task, оба языка и input, однако `prepareGatewayGeneration` передаёт в provider только prepared `messages` и maxTokens, а последнее сообщение канонизирует в явный текст лишь для Ask и Check input (`src/shared/gateway-protocol.ts:23-40,63-89`). Upstream Chat Completions JSON включает model/messages/stream/stream_options/max_tokens; `temperature` не задан (`src/shared/api.ts:168-192`). Значит, Solve/Hint/Check/Explain/Quiz/Translate/Summarize/Simpler сейчас описывают UI intent, но сами не задают его модели. По коду нельзя заключить, что ответ следует учебной или сократической политике.

**FACT.** Существующая архитектура уже хранит `kind`, `input`, `replyTo`, локаль, assistant turns, capture attachment; она строит ограниченную projection истории, отображает исключённые сообщения и позволяет вернуть их действием Use again (`src/shared/conversations.ts:8-35,117-206`; `src/chat/chat.ts:493-524`). Новая система состояния не нужна, чтобы сначала определить и проверить semantics.

## Схема userflow и реальные разрывы

| Поток | Что происходит по коду | Gaps относительно labels/ожиданий |
|---|---|---|
| Capture/new chat | Пользователь выбирает область; worker делает crop, сохраняет в `storage.session`, открывает/переиспользует чат. `showCapture` выбирает указанный/current/last chat, иначе создаёт запись и прикрепляет картинку (`src/shared/messages.ts:3-9,115-129`; `src/background/service-worker.ts:48-57,147-161`; `src/chat/chat.ts:163-175`). Capture сам по себе не запускает модель. | Картинка становится контекстом, не заданием. Кнопки Solve/Hint/Check видны сразу, остальные находятся в More (`src/chat/chat.html:26-45`). |
| Solve / Hint / Explain / Quiz / Translate / Summarize | Все идут через `send`, сохраняют kind и пустой task template; контекст берёт assistant/user turns и активное изображение (`src/chat/chat.ts:899-914,955-968`; `src/shared/prompts/index.ts:27-37`). | Текст “реши”, “подскажи”, язык/тип задачи в upstream messages отсутствует. Нельзя трактовать кнопку как обещание policy. |
| Ask | Свободный ввод сохраняется и передаётся как текст; при принятии user turn очищается поле (`src/chat/chat.ts:970-982`; `src/shared/conversations.ts:275-279`). | Ни answerLanguage, ни task mode не превращаются в provider instruction. |
| Check | Кнопка отправляет пустой `check`; отдельного поля попытки нет (`src/chat/chat.ts:984-988`). | Предыдущий Ask текст может быть в истории, но текущему запросу не объяснено, что это попытка. В архитектуре уже есть `Turn.input`, но сейчас для Check кнопки оно не задано. |
| Simpler | Кнопка добавляет отдельный пустой `simpler` turn поверх предшествующей истории (`src/chat/chat.ts:722-725,906-908`). | Надпись “Explain simpler” не попадает в запрос как инструкция. |
| Follow-up/retry | Ask добавляет текстовый user turn. Retry повторяет последний user turn и контекст до него (`src/chat/chat.ts:807-824,917-928`). | Retry не восстанавливает задачу текстом, потому что прежний template отсутствует в provider history. |
| Reuse/Stop | Старый Ask/Check повторяется; старый capture запускает пустой Check (`src/chat/chat.ts:515-521`). Stop прерывает fetch; уже накопленный ответ сохраняется со статусом (`src/chat/chat.ts:868-895,971-976`). | Reuse возвращает контекст, но не фиксирует desired intent. Stop operationally coherent. |
| History/language/title | История локально сохраняет turns и attachments (`src/chat/chat.ts:1020-1061`). `uiLanguage`/`answerLanguage` раздельны в settings (`src/shared/settings.ts:4-38`). В каждом generation передаётся `titleNeeded:false`; title берётся из ввода/fallback (`src/chat/chat.ts:813-821`; `src/shared/conversations.ts:56-72`). | Оба языка доходят до gateway, но не до model messages; `auto` не имеет исполняемой семантики. Заголовок не запрашивается у модели. |

Контекст объединяет turns по задаче/изображению, исключает незавершённые и устаревшие ответы, выбирает свежие целые группы в пределах приблизительной оценки; старые user text/image можно вернуть вручную (`src/shared/conversations.ts:117-206`; `src/chat/chat.ts:493-524`). `contextTurnText` включает только Ask/Check input, не старые task prompts (`src/shared/conversations.ts:275-279`). Поэтому **исторические GPT-4.1-era** [`docs/prompts-research.md`](prompts-research.md) и примеры качества [`docs/prompts-quality/`](prompts-quality/) не описывают текущий запрос. В частности старый документ рекомендует `temperature=0`; фактически температура не отправляется. ToDo утверждает, что `temperature` реализован per-turn, что расходится с кодом (`src/shared/api.ts:182-191`; `src/shared/prompts/index.ts:39-54`).

## Технические факты

- OpenAI model card описывает GPT-6 Luna как general-purpose efficient model; image input поддерживается, text — input/output. Карточка сообщает контекст 1,050,000, max output 128,000, reasoning effort modes; это лимиты/возможности API, не качество tutoring и не обещание решения заданий. Сейчас приложение использует OpenRouter ID `openai/gpt-6-luna`, max_tokens 16,384, не задаёт temperature (`src/shared/ai.ts:7-12`; `src/shared/prompts/index.ts:39-54`). Карточка указывает fine-tuning unsupported.
- OpenRouter Chat Completions и models catalog документируют совместимый request shape и свойства конкретных моделей. Для фактического запроса этого приложения первичны его own `src/shared/api.ts` и серверная подготовка `src/backend/app.ts:252-269`; каталог не доказывает корректность поведения модели.
- **HYPOTHESIS:** начать с intent-контракта и оценок на реальных типах входа, не добавляя tools, fine-tuning, RAG, learner profile или multi-agent. OpenAI model optimization guide поддерживает цикл: зафиксировать baseline на representative inputs, задать ясные инструкции/контекст, повторять измерение. Она отдельно говорит о недетерминизме и меняющемся behavior snapshots. Применять этот общий принцип можно без hosted eval API.

## Эмпирическая опора и её пределы

- **Самообъяснение.** Chi et al. (1994), эксперимент с учащимися, изучающими объяснение кровообращения, связывает содержательные self-explanations с лучшим пониманием сложных вопросов. Aleven & Koedinger (2002), две classroom studies Cognitive Tutor, нашли лучшее понимание и transfer-задачи, когда учащиеся объясняли шаги решения. Это поддерживает возможность попросить пользователя объяснить свой шаг; это не доказывает, что любое LLM-объяснение улучшает learning.
- **Retrieval.** Roediger & Karpicke (2006): в двух экспериментах со студентами и прозой свободное воспроизведение дало преимущество перед повторным изучением на отложенных проверках 2 дня/1 неделя, хотя на 5-минутной проверке повторное изучение было лучше. van den Broek et al. (2025) рандомизировали участников в stepwise worked examples с/без попытки предсказать следующий небольшой шаг; после ответа участник видел шаг как feedback и мог его перечитать. Через неделю выросли recall процедуры и problem-solving. Это обученный, сегментированный формат; он занимал больше времени и не равен одиночной свободной кнопке Quiz.
- **LLM outcomes.** Bastani et al., PNAS 2025, field RCT почти с 1000 школьников по математике: GPT-4 помогал решать practice problems, однако снятие AI access выявило риск худшей независимой экзаменационной работы при обычном чате. GPT Tutor смягчал ущерб. Важная граница: Tutor менял поведение и давал учительские правильные решения, типовые ошибки и подсказки; результат не изолирует эффект одной system prompt. Outcome — ближайшие экзамены, не долговременная retention.
- Kestin et al., Scientific Reports 2025: crossover RCT (N=194) со студентами вводной физики Harvard сравнивал два урока с одинаковым содержанием, AI tutor и активный класс; сообщён лучший немедленный post-test результат и меньшее время в AI-условии. Это был связанный пакет: prompt, материалы/видео, авторские content-rich ответы и платформа, проходящая задачи по порядку. Авторы пишут, что prompt не гарантировал последовательность в многосоставных заданиях; результат не измеряет долгосрочную retention и не доказывает эффект одного prompt.

**Продуктовый вывод — HYPOTHESIS.** Evidence поддерживает возможность выбора между worked example, подсказкой, попыткой объяснить свой шаг и повторной практикой. Она не требует запретить прямое решение, заставлять всех идти сократически или считать assisted completion доказательством обучения. Быстрый ответ тоже может быть сознательным пользовательским намерением.

## Кандидаты на малый следующий срез

1. Явно определить intent для существующих видов хода, пользуясь текущими `Turn.kind` + messages; только после этого решить, нужно ли добавлять пользовательское поле/связь.
2. Если Check должен проверять попытку, определить где её вводит пользователь и как она связывается с задачей. Опциональная основа уже существует в `Turn.input/replyTo`, но текущая кнопка её не задаёт.
3. Сохранить Solve как возможный прямой worked-example режим и Hint как отдельную добровольную поддержку. Формулировку результата пользователь утверждает; здесь нет готовых prompt strings.
4. Quiz потребует определить цикл «вопрос → ответ ученика → feedback»; сейчас это одно поколение без отдельного answer input/score state.
5. Язык: решить ожидаемое поведение `auto`; затем отразить его в явном wire-level instruction contract. Сейчас настройка не ограничивает текст модели.
6. До теста поведения собирать матрицу: correctness (ответ/ошибка/нечитаемый кроп), pedagogy (соответствие выбранному intent, качество feedback), UX (языки, follow-up/retry/reuse/stop, прямой ответ), learning (самостоятельная похожая задача без модели; delayed test только в отдельном исследовании). Assisted success и independent transfer/retention — отдельные показатели.

## Первый decision point

**OPEN — что должен означать Solve?** Факт: кнопка сохраняет task kind, но не передаёт инструкцию модели. Исторический prompt и его результаты не являются текущим решением.

1. **Прямой worked example (рекомендация):** сохранить буквальное обещание Solve и помочь тем, кому нужен полный разбор; позже можно добровольно предложить аналогичный шаг для практики. Риск: прямое копирование.
2. **Начать с попытки, решение только по запросу:** может вовлечь retrieval, но создаёт трение и меняет значение Solve.
3. **Спросить: показать решение или начать с подсказки:** явный контроль trade-off ценой дополнительного UI шага.

Рекомендация — вариант 1 как base intent, Hint остаётся отдельной кнопкой; следующий практический шаг добровольный. Это HYPOTHESIS, не DECISION.

Дальше последовательно OPEN: (а) Hint — одна/постепенные подсказки и допустимость ответа после просьбы; (б) Check — typed attempt, решение на изображении или оба; (в) Quiz — один вопрос или полноценная практика; (г) точная семантика answer-language auto. Только затем выбирать wire fields и реализацию.

## Источники

**Технические первоисточники:** [OpenAI GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) (model capabilities); [OpenAI model optimization](https://developers.openai.com/api/docs/guides/model-optimization) (eval-driven измерение); [OpenRouter Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion); [OpenRouter models catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties). Проверены 2026-10-19.

**Оригинальные статьи:** Chi et al. 1994, [Eliciting Self-Explanations Improves Understanding](https://doi.org/10.1207/s15516709cog1803_3); Aleven & Koedinger 2002, [Learning by doing and explaining with a Cognitive Tutor](https://doi.org/10.1207/s15516709cog2602_1); Roediger & Karpicke 2006, [Test-enhanced learning](https://pubmed.ncbi.nlm.nih.gov/16507066/); van den Broek et al. 2025, [Retrieval Practice in Stepwise Worked Examples Improves Learning](https://doi.org/10.1016/j.learninstruc.2025.102196), [original PDF](https://research-portal.uu.nl/ws/files/269108220/1-s2.0-S0959475225001203-main.pdf); Bastani et al. 2025, [PNAS article](https://doi.org/10.1073/pnas.2422633122), [author PDF](https://hamsabastani.github.io/education_llm.pdf); Kestin et al. 2025, [Scientific Reports paper](https://doi.org/10.1038/s41598-025-97652-6), [publisher PDF](https://www.nature.com/articles/s41598-025-97652-6.pdf).
