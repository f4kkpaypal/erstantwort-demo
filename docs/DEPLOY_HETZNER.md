# Сервер для одного бюро

Инструкция для Романа. Юридический текст здесь не заменяет юриста. Пока нет регистрации ИП, боевой сайт с чужими заявками не открывайте: локальное демо и тестовый ящик этого не требуют.

Демо на ноутбуке запускается как раньше, без этой страницы. Сервер нужен, когда бюро должно открыть Mini App по ссылке в Telegram.

## Render Free — не продуктив

В этом репозитории нет `render.yaml` и `Dockerfile.free`. Если такой файл появится отдельно или кто-то поднимет Render Free и назовёт это «EU-Hosting», это только тестовый хостинг. Реальные заявки, почту и персональные данные туда не класть. Продуктив — VPS Hetzner в ЕС, Фалькенштайн или Нюрнберг, как ниже. Render Free для настоящего бюро не подходит.

## Что должно быть под рукой

Отметьте, прежде чем платить за сервер.

- Регистрация на Hetzner и карта. Сервер: Ubuntu, 2 vCPU, 4 ГБ, Фалькенштайн или Нюрнберг. Так уже написано в README.
- Домен. Две записи A на IP сервера: одна для n8n (`SITE_ADDRESS`), одна для Mini App (`APP_ADDRESS`). Пример: `hooks.buero.de` и `app.buero.de`.
- Почта для сертификата Let's Encrypt (`ACME_EMAIL`). Это не ящик заявок.
- SSH-ключ, которым вы заходите на сервер.
- Ящик бюро: хост, порт, логин и пароль IMAP и SMTP. Пароль только в `.env` на сервере.
- Telegram: токен бота и числовые id сотрудников. Для сигнала «движок замолчал» отдельный chat id Романа (`OPS_TELEGRAM_CHAT_ID`). В сигнал не попадают имя и почта лида.
- Данные ИП: имя, адрес, e-mail. Пока их нет, `OFFICE_MODE` оставьте `demo`. В `live` без них движок не стартует.
- Google — только если нужны таблица и календарь бюро. Иначе календарь локальный.
- Юрист посмотрел `docs/AVV_CHECKLIST.md` до первой настоящей заявки, включая бесплатные 30 дней.

## Один запуск

На сервере, в каталоге проекта, после `python3 scripts/init_env.py`:

```bash
sh scripts/battle.sh
```

Скрипт читает `.env` и не печатает его. Если нет `SITE_ADDRESS`, `APP_ADDRESS` или `ACME_EMAIL`, он останавливается с `prod_env_incomplete`.

Перед этим в `.env`:

- `UI_PUBLIC_BASE=https://app.ваш-домен` — тот же адрес, что `APP_ADDRESS`, со схемой `https://`.
- `N8N_HOST`, `N8N_EDITOR_BASE_URL` и `WEBHOOK_URL` на `https://` адрес n8n.
- `N8N_PROTOCOL=https` и `N8N_SECURE_COOKIE=true`.
- `EDITOR_ALLOW_CIDRS` — IP офиса через пробел. С других адресов редактор n8n закрыт.
- `HOST` внутри контейнера уже `0.0.0.0`. Наружу порты движка и Mini App смотрят только на `127.0.0.1`. Снаружи их открывает Caddy.
- `MAIL_MODE`, `IMAP_MODE`, `LLM_MODE` не включайте в боевые, пока не заполнены секреты. По умолчанию почта в файл, модель — заглушка.
- `OWNER_LEADS_ENABLED=false`.
- `DEMO_UI_NO_AUTH=false`, когда почта уже настоящая.

Проверка, что процесс жив:

```bash
curl -sS http://127.0.0.1:18787/v1/health
curl -sS http://127.0.0.1:18791/healthz
```

Снаружи, когда DNS уже указывает на сервер: `https://APP_ADDRESS/` открывает Mini App, `https://APP_ADDRESS/engine/v1/health` отвечает здоровьем движка. Остальные пути движка снаружи не опубликованы. Webhook n8n остаётся на `SITE_ADDRESS`.

Конфиг Caddy: `Caddyfile.prod`. Синтаксис проверяется так (нужен Docker, наружу ничего не публикует):

```bash
docker run --rm \
  -e ACME_EMAIL=ops@example.com \
  -e SITE_ADDRESS=hooks.example.com \
  -e APP_ADDRESS=app.example.com \
  -e EDITOR_ALLOW_CIDRS=127.0.0.1 \
  -e ENGINE_PUBLISH_PORT=18787 \
  -e WEB_PUBLISH_PORT=18791 \
  -v "$PWD/Caddyfile.prod:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

## Копии

Раз в день на сервере:

```bash
node scripts/ops.js backup
node scripts/ops.js restore-check
```

Первая команда копирует SQLite и, если рядом запущен Postgres из compose и пароль не заглушка, снимает дампы баз `n8n` и `makler` через `pg_dump` внутри контейнера. Пароль в команду не подставляется. Вторая открывает копию SQLite во временной папке и проверяет, что дампы не пустые и не содержат пароль Postgres. Живые данные она не затирает.

`N8N_ENCRYPTION_KEY` храните отдельно от дампа. Без него n8n не прочитает свои секреты.

Если Docker не запущен, копия SQLite всё равно пишется, а строка будет `postgres=skipped`.

## Если замолчало

Сервис `watch` в боевом compose раз в пять минут спрашивает здоровье движка и страницы. Когда `TELEGRAM_MODE=telegram` и задан `OPS_TELEGRAM_CHAT_ID`, в Telegram уходит одна фраза без персональных данных. В режиме `log` наружу ничего не уходит, строка пишется в `health-alert.log`.

Вручную: `node scripts/watch.js`. Код выхода 1 значит, что проверка не прошла.

## Второе бюро

Отдельный каталог, не общая база и не правка кода. Смотрите раздел в `docs/ONBOARDING_BUERO.md`. На одном сервере у второго бюро свои порты и своё имя проекта compose, иначе тома смешаются.
