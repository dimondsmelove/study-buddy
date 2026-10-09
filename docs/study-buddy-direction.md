# Study Buddy — UI direction

Дата: 2026-10-09. Поверхность: extension chat iframe и его floating host. База: 7803ed3, branch loop/study-buddy-ui-luna-2026-10-09.

## Основание и границы

Пользователю предложены спокойный светлый рабочий интерфейс (рекомендация), тёплый учебный блокнот и тёмный инструмент. После рекомендации он ответил «Хорошо» и поручил основную реализацию Луне с проверкой кода и отдельного Chromium. Для этого среза используем рекомендованный спокойный светлый вариант. Точные CSS tokens и компоновка — инженерная реализация этой рамки; новую продуктовую семантику молча не добавлять. Именованных love references пользователь не задавал.

Основной образ: компактная рабочая панель рядом с заданием, в которой читают ответ и продолжают диалог. Не добавлять RPG sidebar, atom grid, герой-блоки, dashboard-карточки, новый UI framework или сервер.

## Компоновка

Компактная служебная шапка; узнаваемый источник/изображение с раскрытием; видимые «Решить», «Подсказка», «Проверить», остальные четыре задачи в «Ещё»; диалог без лишних вложенных рамок; закреплённый доступный composer. Check использует ту же область ввода, сохраняет multiline и понятный возврат. Модель/провайдер/endpoint/API key/Advanced полностью уходят из DOM обычных настроек. Runtime dev-подключение остаётся внешней настройкой запуска, языковой Save его сохраняет.

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

Сохранить все принятые lifecycle/stream/storage/prompt инварианты; не создавать параллельный state manager или transport. Проверить UI в fresh agent-owned Chromium на default viewport1280×800, small viewport и min panel ширине320, RU/EN, без горизонтального overflow/невидимых обязательных действий. More, Check, Settings, History, long answer/LaTeX, busy/cooldown/error, minimize/restore/close — реальные rendered states. Screenshots только временные, посмотреть и удалить; сохранить harness/JSON metrics. Отдельно проверить отсутствие ключа в DOM и сохранение existing connection при language Save. Никаких реальных credentials в QA, никаких платных calls. Проверки с fake provider не подменяют реальную модель в ручном playtest.
