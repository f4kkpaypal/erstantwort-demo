# D criteria → test

German suite before the international work: 90. Holdout D4 stays outside the repo (`docs/HOLDOUT_FORMAT.md`).

| Criterion | Where |
| --- | --- |
| D1 D2 D3 | `test/intl/mvp.test.js` and one test per message in `test/intl/messages.test.js` |
| D5 D6 D7 D8 D9 D11 D13 D15 D17 D18 D18б D20 D28 | `test/intl/mvp.test.js` |
| D10 | rules only at runtime. `analyzeWithLlm` is covered by `test/intl/mvp.test.js` and is not called from ingest. A live model is not connected |
| D14 D16 D21 | `test/intl/network.test.js`. D21 patches `fetch`, `http.request`, `https.request`, `net.connect` and `dns.lookup`, then runs ingest, send, the digest tick and the webhook handler |
| D23 | `test/intl/demo.test.js` runs `scripts/demo_intl.js` |
| D24 | parser is reachable from `POST /v1/intl/telegram` when `TELEGRAM_WEBHOOK_SECRET` matches. The process does not poll `api.telegram.org` and does not send a Telegram message. Scenarios: `test/intl/scenarios.test.js` |
| D25 | `runDigest` and a one-minute timer while the process stays awake (`engine/intlServer.js`). The timer stores that the digest ran. It does not deliver a Telegram message. `POST /v1/intl/digest/send` and `/digest` return `telegram_delivery: false`. SC8 is in `test/intl/scenarios.test.js` |
| D26 D27 | `test/intl/scenarios.test.js` SC1–SC7. `slot_unavailable` is in `test/intl/review.test.js` |
| D29 | startup and `intl.retain()` clear message text after `retention_until`. `POST /v1/intl/leads/:id/erase` deletes that sender's rows and keeps `i_optout`. Stale `sending` is still swept on startup, on send, and on the one-minute timer |
| Suffix, word amounts, assumed currency, empty `lang_other`, mixed intent, STOP phrases | `test/intl/edges.test.js` and `test/intl/review.test.js` |
| D4 | `npm run holdout -- <path>` exits 0 only when every stated expectation matches and there is no false or missed STOP. See `docs/HOLDOUT_FORMAT.md` |
| D12 | audit rows are written for send, stop, digest, settings; a full leak scan of every action is not a separate test |
| D19 | dark EN and RU screenshots in `docs/intl-ui/` (inbox, lead, edit sheet, viewings, properties, setup), taken from the running app |
| D22 | new international tests are the files under `test/intl/`. The spec asked for 80 new tests. This tree adds real cases and does not pad empty ones. |
