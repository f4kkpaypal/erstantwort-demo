# Бесплатный публичный HTTPS-адрес для теста Mini App (Erstantwort)

Проверено 26.10.2026 по официальным страницам тарифов. Только демо, вымышленные данные.

## Сравнение

| Вариант | Бесплатно сейчас | Карта | Засыпание / лимиты | Регион | Источник |
|---|---|---|---|---|---|
| **Render (Free web service)** | Да | Не нужна («No payment is required») | Засыпает через 15 мин без запросов, просыпается ~1 мин; 750 ч/мес; 512 МБ; диск стирается при каждом перезапуске | Есть Frankfurt | https://render.com/docs/free , https://render.com/docs/your-first-deploy , https://render.com/docs/regions |
| Railway | Пробный период $5 на 30 дней, потом $1/мес кредита | Не нужна | Без проверки GitHub-аккаунта ограничены исходящая сеть и порты («Limited Trial») | Регион: не проверено | https://docs.railway.com/pricing/free-trial |
| Deno Deploy (Free) | Да (1 млн запросов, 20 ГиБ трафика) | На странице тарифов не указана; не проверено | Простаивающие приложения выключаются через ~20–30 с | Регион: не проверено | https://deno.com/deploy/pricing |
| Fly.io | Нет: только пробный период 2 часа или 7 дней | Не нужна для старта, потом обязательна | Пробные машины сами останавливаются через 5 мин | Есть Европа | https://docs.fly.io/about/free-trial |
| Koyeb | Нет для новых аккаунтов с февраля 2026 (Pro $29/мес) | Нужна | — | Frankfurt | https://www.koyeb.com/docs/faqs/pricing , https://hostmath.dev/guides/koyeb-pricing-2026 |
| Hugging Face Spaces (Docker) | Нет: Docker Space требует платную подписку | — | — | — | https://huggingface.co/docs/hub/spaces-overview |
| Oracle Cloud Always Free | Да, но карта обязательна для верификации | Нужна | Во Frankfurt ARM-мощностей часто нет | Frankfurt | https://www.oracle.com/europe/cloud/free/faq/ |
| Google Cloud e2-micro | Да, но нужен billing-аккаунт | Нужна | Только регионы США | США | https://docs.cloud.google.com/free/docs/free-cloud-features |
| Cloudflare Workers/Pages, Glitch-аналоги | Не проверено | — | Не проверено | — | — |

## Что нельзя с моего компьютера (проверено)
Из песочницы наружу выходит только HTTPS 443. Cloudflare quick tunnel (порт 7844), ssh-туннели, tunnelmole (порт 8083, обрыв TLS) не работают, localtunnel даёт 502, ngrok требует аккаунт. Бесплатного адреса без регистрации получить не удалось. Токенов Render/Fly/Railway на машине нет. Репозиторий лежит в Cursor Origin (приватный), не на GitHub. Подключённый к Cursor GitHub-аккаунт `f4kkpaypal` не подтверждён как аккаунт Романа, пушить туда без явного разрешения не стал.

## Рекомендация: Render Free, регион Frankfurt
Проще всего и без карты. Минус: через 15 минут простоя засыпает, первое открытие ~1 минута; данные демо в памяти и при засыпании сбрасываются (для демо нормально). Для боевого режима не подходит.

## Что готово (в /workspace/anfragen-autopilot)
- `scripts/free_host.js`: один процесс, движок на 127.0.0.1:18788 и web на публичном $PORT. Авторизация включена (DEMO_UI_NO_AUTH=false), MAIL_MODE=file, LLM_MODE=mock, разрешён только Telegram id 5031998736. ENGINE_TOKEN и HASH_SALT генерируются при каждом старте. Адрес берётся из RENDER_EXTERNAL_URL. Токен бота читается только из окружения и не печатается.
- `Dockerfile.free`: Node 22, запуск `node scripts/free_host.js`.
- `render.yaml`: Blueprint (Free, Frankfurt, TELEGRAM_BOT_TOKEN с `sync: false`, его вводит владелец в панели Render).
- Проверено локально на Node 22.23: старт, `/healthz` = ok, `/` = 200, `/v1/ui/leads` без Telegram-входа = 401. В Docker и на Render не запускалось (Docker нет).

## Шаги для Романа
1. Открыть https://render.com, «Sign up with GitHub» (или по e-mail). Карта не нужна.
2. Код должен лежать на GitHub (Render не читает Cursor Origin). Главный агент по явному разрешению Романа кладёт код в новый приватный репозиторий на GitHub-аккаунте Романа (файл .env не включать), либо Роман создаёт пустой репозиторий и даёт доступ.
3. В Render: New → Blueprint → выбрать репозиторий → Render прочитает `render.yaml` → в поле TELEGRAM_BOT_TOKEN вставить токен бота (только в это поле Render, не в чат) → Apply.
4. Через 3–5 минут появится адрес вида `https://erstantwort-demo-xxxx.onrender.com`. Проверка: `<адрес>/healthz` должен вернуть «ok».
5. Главный агент ставит кнопку меню бота на этот адрес (Bot API setChatMenuButton, chat_id 5031998736, тип web_app); токен из окружения, не в чат.
6. Роман открывает @ImmobilierXbot в Telegram и нажимает кнопку «Erstantwort». После простоя первое открытие около минуты.

## Что нужно от Романа
Аккаунт Render (бесплатно, без карты), разрешение выложить код в приватный GitHub-репозиторий, ввод токена бота в защищённое поле Render. Токен нужен, потому что вход из Telegram проверяется подписью на основе токена.

## Риски
- Free-сервис засыпает: бот на опросе (polling) в это время не отвечает до пробуждения. Для теста Mini App приемлемо.
- Условия Render могут измениться; проверено на дату выше.
