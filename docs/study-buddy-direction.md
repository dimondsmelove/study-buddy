# Study Buddy — UI direction

> **HISTORICAL CONTEXT.** Dated decisions, status claims and task order below describe earlier slices. For current implementation, validated artifacts and remaining work, read [CURRENT-STATE.md](../CURRENT-STATE.md). Do not restore old tokenizer, provider-key UI or retired model settings from this document.

Дата: 2026-10-09; уточнено 2026-10-11. Поверхность: extension chat iframe и его floating host. База: 7803ed3, branch loop/study-buddy-ui-luna-2026-10-09.

## Основание и границы

Пользователю предложены спокойный светлый рабочий интерфейс (рекомендация), тёплый учебный блокнот и тёмный инструмент. После рекомендации он ответил «Хорошо» и поручил основную реализацию Луне с проверкой кода и отдельного Chromium. Для этого среза используем рекомендованный спокойный светлый вариант. Точные CSS tokens и компоновка — инженерная реализация этой рамки; новую продуктовую семантику молча не добавлять. Именованных love references пользователь не задавал.

Основной образ: компактная рабочая панель рядом с заданием, в которой читают ответ и продолжают диалог. Не добавлять RPG sidebar, atom grid, герой-блоки, dashboard-карточки, новый UI framework или сервер.

## Компоновка

Компактная служебная шапка с New chat; изображения с раскрытием в ленте сообщений, без постоянного верхнего превью; шесть видимых действий с иконкой, короткой подписью и подсказкой: «Решить», «Подсказка», «Проверить», «Объяснить», «Перевести», «Конспект» (уточнение пользователя 2026-10-20 заменяет More); диалог без лишних вложенных рамок; закреплённый доступный composer с компактным оценочным token budget / Details и иконкой New selection. Check сразу отправляет проверку текущего изображения; обычный свободный ввод остаётся доступен. Модель/провайдер/endpoint/API key/Advanced полностью уходят из DOM обычных настроек. Runtime dev-подключение остаётся внешней настройкой запуска, языковой Save его сохраняет.

Не увеличивать default host 480×600 ради сокрытия проблем плотности. Ориентир thread >=300px при этом размере; подтвердить реальные метрики и объяснить компромисс, если не достигнут. При узкой/низкой панели вторичные элементы компактно перестраиваются, обязательный ввод остаётся доступным. Drag/resize/minimize/close и протокол их lifecycle не менять ради оформления.

## Визуальные tokens

Одна существующая system-ui sans family для tool UI (product register impeccable); KaTeX сохраняет свою типографику. Не загружать внешние шрифты и не добавлять зависимости. Ответ 16px/1.5; controls 14px, metadata 12px; названия/заголовки 16–18px с умеренным весом. Подтвердить читаемость формул, RU labels и длинных сообщений.

Базовая палитра (семантические имена перед использованием; допускаются локальные уточнения оттенков при проверке контраста):

- surface: #fbfcfe; toolbar/surface-muted: #f1f5fa; ink: #1f2937; muted: #526174; line: #d9e2ed.
- accent: #2563eb; accent-hover: #1d4ed8; accent-ink: #ffffff; focus: #2563eb.
- error ink/surface: #b42318 / #fff4f2; warning ink/surface: #92400e / #fff7ed.
- spacing scale 4/8/12/16/24px; radius control 6px, group 10px, host 12px.
- motion state transitions 150ms; reduced-motion removes them. Никаких decorative entrance, transition-all, bounce, gradients или emoji-функциональных иконок.

Акцент обозначает primary action, focus и активный выбор; не заливать им всё сообщение/панель. Body/button/placeholder контраст >=4.5:1; именованные text-on-accent tokens. Reachable control targets 44px; иконки могут быть визуально меньше области нажатия. Новый popover/dropdown не клипается overflow-контейнером и закрывается клавиатурой/внешним кликом.

## Приёмка

Сохранить все принятые lifecycle/stream/storage/prompt инварианты; не создавать параллельный state manager или transport. Проверить UI в fresh agent-owned Chromium на default viewport1280×800, small viewport и min panel ширине320, RU/EN, без горизонтального overflow/невидимых обязательных действий. Все шесть действий и их hover/focus-подсказки, Check, Settings, History, long answer/LaTeX, busy/cooldown/error, minimize/restore/close — реальные rendered states. Screenshots только временные, посмотреть и удалить; сохранить harness/JSON metrics. Отдельно проверить отсутствие ключа в DOM и сохранение existing connection при language Save. Никаких реальных credentials в QA, никаких платных calls. Проверки с fake provider не подменяют реальную модель в ручном playtest.


## История — уточнение 2026-10-10

DECISION: компактные строки вместо title/count/full timestamp. Название — основной ориентир с более сильным весом, дата и время — вторичный: Today / Yesterday · HH:mm, для старых — короткий месяц/день и время; год только за другой календарный год. Корзина в той же строке, область нажатия 44px, доступное имя включает название чата. Подтверждение внутри интерфейса, с Cancel/Delete, видимой ошибкой и сохранением данных при сбое. JSON Export убран.

DECISION: шестерёнку и обработчик закомментировать; языковой код сохранить. Defaults en/en, текущий dev переключить на English без изменения подключения. История — не более 20 чатов по последнему сообщению, для пустого по созданию. Просмотр/выделение не продвигают чат. Политика применяется и к накопленным данным; общий image Blob остаётся, пока его использует сохранённый чат. Активный writer защищён внутри лимита до завершения.

HYPOTHESIS / инженерная рамка: тема нового чата приходит вместе с первым ответом модели, без дополнительного вызова. Для старой истории — локальный содержательный фрагмент. Служебная строка названия не попадает в ответ, Copy или следующий контекст. Это следует направлению пользователя на понятные названия как в ChatGPT; конкретный протокол выбран при реализации.


FACT — приёмка 2026-10-10: 51b22b3 принят primary и интегрирован f61ef1c. Независимые проверки 26/26, boundary 5/5, полный native smoke и contracts прошли. В frame 320×324 title/date/delete не перекрываются, Back остаётся доступен, список прокручивается. Новый диалог проверен в настоящем embedded iframe: отмена, failure с сохранением данных, повтор и возвращение фокуса. EN/RU ошибки понятны без internal text. Отдельный реальный Solve дал complete, 84 km/h и сохранённую тему, без metadata в ответе. Скриншоты отрисованного UI просмотрены и удалены. Исходный пользовательский сбой Delete не воспроизведён: корректный Page confirm test cdc73ce удаляет запись; прежнее автоматическое no-op заключение отозвано.


## Вход в сохранённый чат — 2026-10-11

DECISION: правый клик по иконке расширения → Show history → выбор чата. Левый клик и Ctrl+Shift+Y сразу запускают выделение. Пользователь отверг дополнительный launcher popup. После Close старый чат восстанавливается только явным выбором из истории; обычный новый захват сохраняет текущий контракт нового диалога.

FACT: history — отдельное состояние существующей панели. Его открытие не создаёт запись, не захватывает страницу и не запускает модель. Открытая/свёрнутая панель переиспользуется; активное выделение отменяется. Back при отсутствии выбранного чата закрывает историю. На restricted page список открывается отдельным окном без capture permission prompt. Native context menu требует разрешения contextMenus; пункт ограничен contexts:['action'].

FACT — приёмка: Luna 6e5b223, независимая primary-проверка 28/28 в отдельном headed Chromium на собственном Xvfb. Проверены настоящий правый клик по закреплённой иконке, единственный пункт после reload, empty Back/Close, возврат точного ID/transcript/Blob, продолжение с прежним контекстом, minimize/reuse, отмена выделения и restricted fallback. Два явных запроса только к localhost mock, платных вызовов нет. Typecheck, keyless build и полный native verify прошли; временные снимки просмотрены и удалены.


## Диалог с изображениями и видимость контекста — принято 2026-10-11

DECISION: пользователь подтвердил план и сказал «Стартуй». New chat создаёт пустой диалог с доступным текстовым вводом; New selection добавляет изображение в текущий чат. Обозначения и расположение этих действий должны ясно различаться. Каждый успешный захват сразу становится отдельным сообщением в ленте, без вызова модели. Прежние изображения остаются в диалоге и раскрываются крупнее; постоянное верхнее превью убирается. Один захват даёт одно сохранённое сообщение даже при повторном handoff.

Решение от 2026-10-11 о счётчиках сообщений/изображений ниже заменено 2026-10-11: показывать оценочный token budget и Details; исключённые строки остаются читаемыми и приглушёнными с конкретной причиной и действием возврата. Payload и UI используют одну context projection.

DECISION (обновлено 2026-10-11): один чат — непрерывная локально сохранённая сессия. На каждый запрос передаётся целый контекст в пределах примерно 200 000 оценочных входных токенов с резервом 20 000; целые старые группы заданий исключаются первыми. Текст оценивается закреплённым DeepSeek V4.1 tokenizer, изображения резервируются по документированному пределу 1 024 токена каждое; оценка сверяется с фактическим OpenRouter usage. Оценка не считается точным preflight. Нет автоматического summary и постоянной памяти заданий. Изображения имеют отдельный внутренний per-file guard 4 МиБ до base64/JSON, не заявленный предел провайдера. Исключённые записи остаются читаемыми, приглушаются с причиной, их можно отправить повторно. Check сразу проверяет видимую в текущем изображении работу и сообщает, если проверять нечего; свободный ввод сохраняется. Одноразовое Check не требует формы попытки. Нижняя зона панели компактна, отправка и New selection обозначены доступными иконками. Старые численные лимиты 12/32 000/2 не являются требованиями. Backend и paid evaluation отложены. Новые сообщения-захваты не продвигают history recency сами по себе: прежнее правило продвижения только запросом пользователя сохраняется. Старые сохранённые чаты должны читаться без потери/перезаписи их исходной истории.

HYPOTHESIS / инженерная рамка: расширить существующий Turn для сообщения-изображения и атомарный attachCapture; не вводить отдельное хранилище сообщений. Продолжить использовать activeAttachmentId как текущую задачу для Solve/Hint/Check, без постоянного UI-превью. Идентификаторы состава запроса и причины исключения вернуть из существующего context builder; не считать вторую независимую UI-проекцию. Название формируется с первым ответом независимо от наличия capture turns.

PLAN: одна Luna выполняет проверяемые инкременты хранения/лент, действий и контекста UI; primary владеет интеграцией, документацией и независимой приёмкой. Проверить два захвата без модели, A→ответ→B→вопрос по обоим, третье изображение, границы text/messages/image bytes, старые records, Close/History/restart, Check/Retry, narrow RU/EN и точное соответствие preview→payload. Каждый связный проверенный инкремент — локальный commit, без push/main merge.


FACT — инженерная приёмка: Luna 656d8dc; runtime интеграция c477433 и дополнительный regression test c101299. Capture turn добавляется атомарно вместе с Blob; повтор A после B не меняет активный B, порядок и данные. Захват не продвигает recency. Единая contextProjection отдаёт ID/причины исключения для UI и фактического payload; capture-only API message не содержит пустого текста. Retry использует контекст своего исходного запроса, включая проверку координатором. Старые image-only/повторные references показываются без переписывания transcript.

HISTORICAL FACT — приёмка primary среза 2026-10-11 (его лимиты заменены следующим решением): 33/33 в headed Chromium 151 на собственном Xvfb, 28/28 legacy/boundary/rendered UI, 8/8 числовых/context fixtures. Пять localhost starts в основном сценарии и пять в boundary; реальный провайдер не вызывался. Проверены немедленные два захвата без модели, два изображения в actual payload, конкретные исключения третьего и связанных ответов, Close/History/restart, поздний capture во время stream и original Retry, Check, сохранение draft/видимого unsaved ответа. RU/EN counts/warning/Details доступны на 480×568 и 320×324; metadata 12px, controls 44px, default thread ≈317px. На минимальной высоте ошибка Check временно сокращает ленту до 12px, сохраняя ввод и действия внутри панели.

FACT — границы evidence: в headless основном embedded-сценарии после native dialog Escape иногда не доставлялось pointer/click событие в iframe, хотя кнопка оставалась доступной. Полный основной сценарий дважды прошёл в свежем headed Chromium; причина headless input delivery не объявляется установленным дефектом продукта. Отдельные headless boundary и полный native verify прошли. Общие contracts/storage/prompts, typecheck и keyless build прошли; платная оценка модели не выполнялась. Скриншоты реально просмотрены и удалены; harness/JSON/logs сохранены в evidence-dialogue-20261011/. Это техническая приёмка среза; пользовательская оценка дизайна остаётся ручной.


## Общий чат на веб-страницах — 2026-10-20

DECISION — уточнение пользователя 2026-10-20: один общий активный чат между вкладками; плавающий значок появляется только после Minimize. По умолчанию на странице значка нет. Прежнее утверждение об одобрении постоянного значка было ошибкой интерпретации агента. Объявленные при установке site permissions заменяют прежний режим исключительно activeTab/per-site prompt. Сам значок не создаёт iframe, чат или модельный запрос. Новый захват после Close начинает новый чат; History возвращает сохранённый явно. Minimize сохраняет writer и делает значок доступным на вкладках; Restore скрывает значки, Close закрывает shared chat и убирает значки во всех вкладках. Stop работает из зеркальной панели; навигация writer остаётся interruption без платного auto-resume. Live Vivaldi/установленная сборка в этой работе не изменяются.


## Форматирование во время ответа — 2026-10-20

DECISION: пользователь попросил убрать видимые служебные Markdown/LaTeX символы во время генерации. FACT: живой preview использует тот же sanitized Markdown/KaTeX renderer с каденсом 100мс; незакрытые math spans буферизуются, незавершённые emphasis/code закрываются только в preview. Исходный transcript и Copy не переписываются. Зеркальные панели форматируют сохранённый streaming partial тем же способом. Native fake-provider acceptance проверила heading/bold до завершения, незакрытую и затем закрытую формулу, dollar/underscore внутри code/fence, финальный raw transcript и DOMPurify/XSS; общий cross-tab lifecycle повторно прошёл. Typecheck/build прошли; платных запросов не было.


## Шесть действий и облегчённая панель — 2026-10-20

DECISION: пользователь отверг крупные текстовые кнопки и деление 3 + More; попросил понятные иконки/подсказки и улучшение компоновки. Инженерная реализация внутри принятой светлой рамки: все шесть действий в общей спокойной панели, иконка плюс короткая видимая подпись; локализованный native-popover tooltip на hover/focus, Escape/blur закрывает. При 480px — один ряд, при 320px — 3×2, touch targets >=44px. Solid accent оставлен у отправки, ответ без лишней рамки, composer — единое поле, наружная шапка светлая с 44px minimize/close. Семантика задач/промпты/модель не меняются.

FACT: целевой native Chromium fake-provider прогон прошёл вместе со stream и shared lifecycle. Проверены EN/RU подписи без overflow, tooltip с клавиатуры/мыши и без model calls, narrow 320×324 (thread104px, composer bottom320px). Реальные screenshots обычной и узкой панели и полного floating host просмотрены и удалены. Typecheck, build и contracts/API/storage/prompts/context прошли; полный обновлённый verify выполняется отдельно. Пользовательский Vivaldi/установленная сборка не обновлялись.


FACT — финальные QA-уточнения 2026-10-20: tooltip использует auto popover и явное host→iframe уведомление о внешнем pointerdown; описание очищается при закрытии. У Copy/Simpler/Retry удалён hover-сдвиг, отступ от ответа20px; native geometry проверила точное совпадение midpoint с краем ответа и11px до текста, соседнее сообщение не перекрывается. Общий lifecycle native-прогон с restart и restricted fallback прошёл без page errors. Default standalone480×564 сохраняет thread362px; narrow320×324 —104px. Полный монолитный verify после этих последних поправок не повторялся; typecheck/build и соответствующие целевые сценарии прошли.


## Model and sliding context update — 2026-10-21

DECISION: primary model is `anthropic/claude-haiku-5.5` through the existing OpenRouter path, with reasoning effort `medium` and reasoning output excluded. There is no model fallback. Each task caps output at 8,192 tokens. Nominal input budget is 100,000 estimated tokens; the existing 20,000-token variance reserve remains, so client selection targets at most 80,000. Existing provider max-price settings and the $0.275 generation reserve remain unchanged.

DECISION: context slides by complete recent exchanges even within one image/task or an all-text chat. Always pin the current user task and its necessary source image, then add newest complete exchanges while token and 32 MiB JSON request limits allow. An oversized current task is blocked only when its essential request alone exceeds a valid limit. Saved history is preserved, excluded rows remain muted with reuse, and the boundary explains that older messages remain saved; it qualifies the included current image when that pinned image appears above the boundary. No automatic summaries are introduced.


## Outside page click — 2026-10-21

DECISION: clicking the page outside the floating panel should invoke the existing Minimize behavior. Primary pointerdown outside the panel now minimizes without cancelling the page click. Clicks within the panel and capture-selection mode remain unchanged. The same iframe retains the draft and active generation; restore uses the existing launcher.

FACT: worker and primary independently passed typecheck, context contracts, and the focused real Chromium extension/backend fixture (`npm run verify:overlay-click`) with a fake provider. The fixture checks click propagation, inside click, same-iframe draft preservation, stream completion while hidden with one provider request, and selection Escape/drag. No paid calls or user-browser changes were needed for acceptance. The existing monolithic verify tooltip scenario now expects outside-click minimize and restores before continuing; the full monolith was not rerun.

LIMITATION: pointer events within other embedded iframes do not reach the top document. Tested blur/activeElement approaches did not identify that case reliably, so this version covers clicks in the main page document. It does not add general window/tab blur behavior.

## Restore across browser tabs — 2026-10-21

DECISION: when an open chat tab becomes hidden, invoke the existing Minimize behavior so the shared launcher appears on other and newly opened tabs. Returning to the source tab leaves its panel minimized. Restoring on another tab opens the same conversation; the source iframe remains mounted for its draft or stream and is reused when returning. Selection mode is excluded, and switching tabs does not cancel a stream or start another request. No launcher appears until a chat has first been opened, and Close clears it across tabs.

FACT: the visibility listener uses the existing shared minimized state and launcher projection. A focused headed Chromium fixture verified native A-to-B activation, destination restoration, a late third tab, returning to A, one continuing mock stream request, selection Escape/drag, and Close cleanup. Playwright focus emulation is disabled by connecting to an isolated Chromium process with `noDefaults`; no synthetic visibility events or real provider calls are used.


## Shared panel geometry — 2026-10-22

DECISION: panel size and position follow the shared conversation across tabs and windows. The first capture anchors the panel when no position is stored; subsequent captures retain that position. Drag and resize persist the user's latest choice. Smaller viewports clamp the rendered panel without replacing the preferred geometry, which returns when the viewport grows. Existing size-only storage remains readable.

FACT: a focused headed Chromium extension fixture used native pointer drag/resize across A→B→A, checked storage updates on already-open tabs, a new tab at 320×324 and restoration after expanding it, and a later capture retaining geometry. A fake stream continued with one request; typecheck and build passed. No real provider calls or user-browser changes were used.


## Long-context notice and conversation title — 2026-10-22

DECISION: show a compact, non-blocking notice below the six task actions when the shared context projection estimates at least 40,000 input tokens. Advise that long context may affect answer quality and suggest starting a new chat. When the projection excludes older exchanges, add that those messages remain saved but are not sent to the model. Incomplete and superseded turns do not trigger the exclusion explanation. Keep the existing muted rows, reuse controls, context window, and request behavior. Render the conversation title at a clearer size and contrast while retaining ellipsis for long titles.

FACT: primary passed 32 rendered Chromium checks with screenshots reviewed in both RU and EN, including estimates at 39,999/40,000/40,001 tokens, old-history omission, draft and error refresh, new-chat reset, incomplete-turn exclusion, and immutable saved history. At the default panel size the notice is 44.4px tall and the thread remains 313.6px; the main view keeps the final reply visible after the notice appears. At the 320×324 minimum, the thread is dense (23.25px RU / 39.4px EN), while the composer remains usable. No model calls were made.

## Capture image visibility — 2026-10-22

FACT: a newly captured image is brought into view after its thumbnail has decoded, including when the active conversation is already streaming. If a conversation update and explicit open race, the render fills an existing capture row instead of leaving it empty; stale render epochs cannot mutate or scroll a different conversation.

FACT: focused headed Chromium coverage held a fake response stream while capturing, verified the newest image within the thread viewport, then repeated captures after completion. The stream remained a single mock request; no real provider calls were made.
