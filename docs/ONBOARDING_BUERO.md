# Подключение одного бюро

Это инструкция для Романа, не для маклера. Юридический текст здесь не заменяет юриста. Пока нет первого настоящего клиента, платные сервисы не нужны: один свой сервер позже, почта бюро, их Google по желанию, Telegram.

Демо на ноутбуке и боевой режим — разные включатели. Демо не трогает чужую почту.

## Демо, как раньше

```bash
export DEMO_UI_NO_AUTH=true ENGINE_TOKEN=local-demo-engine-token HASH_SALT=local-demo-hash-salt
export ENGINE_PORT=18788 UI_PUBLIC_BASE=http://127.0.0.1:18791
export MAIL_MODE=file TELEGRAM_MODE=log LLM_MODE=mock CRM_MODE=file CALENDAR_MODE=mock
node engine/server.js
```

Во втором окне:

```bash
export ENGINE_URL=http://127.0.0.1:18788 WEB_PORT=18791
node web/server.js
```

Открыть http://127.0.0.1:18791/ . Данные вымышленные, из `fixtures/ui_demo.json`. Кнопка «Antwort freigeben» ничего не отправляет.

`HOST` не задавать: слушатель остаётся на 127.0.0.1.

## Боевой режим одного бюро

Скопируйте `.env.example` в `.env`. Секреты только туда, не в git и не в чат.

Поставьте:

- `OFFICE_MODE=live`
- `OPERATOR_NAME`, `OPERATOR_BUERO`, `OPERATOR_ADDRESS`, `OPERATOR_EMAIL` — настоящие данные ИП, когда регистрация будет. Пока их нет, движок в режиме live не стартует и не подставляет нюрнбергскую выдумку.
- `UI_STORE=sqlite` — заявки лежат в `var/autopilot.sqlite` и переживают перезапуск. Фикстура в этом режиме не читается.
- `IMAP_MODE=imap` и `MAIL_MODE=smtp` вместе с хостом, портом, логином и паролем ящика бюро. Без этого почта не ходит.
- `SEND_MODE=approve` — лиду ничего не уходит, пока в Mini App не нажать «Antwort freigeben».
- `LLM_MODE=mock` оставить. Живой Mistral только если поставить `LLM_MODE=live` и ключ. На mock настоящее письмо ImmoScout24, которого нет среди учебных образцов, движок не разберёт.
- `OWNER_LEADS_ENABLED=false`. Канал собственников не включать, пока нет двух настоящих писем Immowelt или Heimziel.
- `SHEET_INCLUDE_CONTACT=false`, если позже включите Google Sheet. В таблицу тогда не пишутся почта и телефон. Локальная база для отправки их хранит.
- `CALENDAR_MODE=google` только вместе с OAuth бюро. Пока `mock`: событие пишется в `var/calendar.json`.
- `TELEGRAM_BOT_TOKEN` и `TELEGRAM_ALLOWED_USER_IDS` — бот и числовые id маклеров этого бюро. Чужой id в Mini App не пускает. `BOT_POLLING=true` вместе с `TELEGRAM_MODE=telegram` включает ответы бота на `/start`, `/help` и любой другой текст. Без флага бот молчит и в сеть за сообщениями не ходит. Кнопка Mini App есть только при адресе `https://`.
- `DEMO_UI_NO_AUTH` оставить `false`. С боевой почтой открытый браузерный вход запрещён.
- `PRODUCT_NAME=Erstantwort`, если не выберете другое имя из конфига.

Проверка, что процесс жив: `GET /v1/health` (нужен только браузер или `node scripts/watch.js`, секрет в ответе не нужен). Если IMAP замолчал, движок пишет в Telegram строку без имени и без почты. Отдельная проверка снаружи: `HEALTH_URL=http://127.0.0.1:8787/v1/health node scripts/watch.js`. Для Telegram этой проверки задайте `TELEGRAM_CHAT_ID`. Токен бота тот же.

Копия и проверка восстановления:

```bash
node scripts/ops.js backup
node scripts/ops.js restore-check
```

Первая команда кладёт копию в `var/backups/`. Вторая открывает последнюю копию во временной папке и проверяет, что база читается. Исходные данные она не затирает.

Публичный HTTPS — когда появится сервер. Пошагово: `docs/DEPLOY_HETZNER.md`. Локально Mini App слушает только 127.0.0.1. Боевой Caddy открывает Mini App на `APP_ADDRESS` и только проверку здоровья движка. Редактор n8n остаётся на своём адресе и только с разрешённых IP.

## Второе бюро без правки кода

У каждого бюро свой каталог и свой файл настроек. Общей базы нет: чужие заявки не видны соседнему офису. Код один и тот же.

```bash
node scripts/office.js init buero-2
```

Команда создаёт `bureaus/buero-2/.env` и пустой `bureaus/buero-2/data/`. Файл настроек в git не попадает. Внутри уже стоят отдельные порты, SQLite и режимы-заглушки: почта в файл, модель mock, канал собственников выключен. Это тестовый режим, регистрация ИП для него не нужна.

Дальше правите только этот файл, не программу:

- ящик: `IMAP_*` и `SMTP_*`, затем `IMAP_MODE=imap` и `MAIL_MODE=smtp`;
- профиль: `OPERATOR_NAME`, адрес, e-mail и `OFFICE_MODE=live`, когда данные ИП есть;
- бот: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, для сигнала Роману `OPS_TELEGRAM_CHAT_ID` и `TELEGRAM_MODE=telegram`;
- объекты: файл `bureaus/buero-2/data/objekte.json` или лист Objekte;
- календарь Google — только если бюро его дало, иначе оставьте `CALENDAR_MODE=mock`.

Проверка, без печати секретов:

```bash
node scripts/office.js check buero-2
```

Запуск на этой машине, два окна:

```bash
node scripts/office.js run buero-2 engine
node scripts/office.js run buero-2 web
```

На сервере, отдельным проектом, чтобы тома не смешались с первым бюро:

```bash
node scripts/office.js compose buero-2
```

Команда только печатает строку для Docker. Её можно скопировать. Секретов в ней нет.

Удаление по сроку уже работает в процессе: просроченная заявка исчезает, хеш STOP остаётся. Сигнал в Telegram не содержит имени и почты.

## Что попросить у бюро

Ящик, куда ImmoScout24 уже шлёт заявки, и разрешение читать его по IMAP и отвечать по SMTP. Список объектов в `var/objekte.json` или в листе Objekte, если включите Sheet. Id Telegram тех, кому можно открывать Mini App. Календарь Google — по желанию. Договор и тексты с юристом — до первой настоящей заявки, см. `docs/AVV_CHECKLIST.md`.
