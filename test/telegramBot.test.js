'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../core/config');
const { replyToIncoming, CLOSED } = require('../core/telegram');
const { pollingEnabled, pollTick, startBotPolling } = require('../engine/telegramPoll');

const TOKEN = '123456:test-token-not-real';

function config(extra = {}) {
  return loadConfig({
    PRODUCT_NAME: 'Erstantwort',
    TELEGRAM_ALLOWED_USER_IDS: '4242',
    UI_PUBLIC_BASE: 'http://127.0.0.1:18791',
    TELEGRAM_MODE: 'telegram',
    TELEGRAM_BOT_TOKEN: TOKEN,
    BOT_POLLING: 'true',
    ...extra,
  });
}

function update(userId, text, updateId = 7) {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      text,
      chat: { id: userId },
      from: { id: userId, is_bot: false, first_name: 'Roman' },
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test('the bot explains itself to an allowed user and stays closed to everyone else', () => {
  const allowed = replyToIncoming(update(4242, '/start'), config());
  assert.match(allowed.text, /Erstantwort/);
  assert.match(allowed.text, /Freigabe/);
  assert.match(allowed.text, /черновик/);
  assert.match(allowed.text, /Mini App/);
  assert.equal(allowed.replyMarkup, undefined);
  assert.doesNotMatch(allowed.text, /@|Roman|Anna/);
  const help = replyToIncoming(update(4242, '/help'), config());
  const other = replyToIncoming(update(4242, 'Guten Tag, meine Mail ist a@b.de'), config());
  assert.equal(help.text, allowed.text);
  assert.equal(other.text, allowed.text);
  assert.doesNotMatch(other.text, /a@b\.de/);
  const closed = replyToIncoming(update(999, '/start'), config());
  assert.equal(closed.text, CLOSED);
  assert.equal(closed.text, 'Dieser Bot ist nicht öffentlich.');
  assert.equal(closed.replyMarkup, undefined);
  assert.equal(replyToIncoming({ update_id: 1 }, config()), null);
  assert.equal(loadConfig({}).BOT_POLLING, false);
  assert.equal(pollingEnabled(loadConfig({ BOT_POLLING: 'true', TELEGRAM_MODE: 'log' })), false);
  assert.equal(pollingEnabled(config()), true);
});

test('an https base adds a Mini App button and http does not', () => {
  const live = replyToIncoming(update(4242, '/start'), config({
    UI_PUBLIC_BASE: 'https://app.example.com/mini/',
  }));
  assert.equal(live.replyMarkup.inline_keyboard[0][0].web_app.url, 'https://app.example.com/mini');
  assert.match(live.text, /Taste unten/);
  assert.match(live.text, /Кнопка ниже/);
  const local = replyToIncoming(update(4242, '/start'), config({
    UI_PUBLIC_BASE: 'http://127.0.0.1:18791',
  }));
  assert.equal(local.replyMarkup, undefined);
});

test('long polling answers from a mocked Telegram API and does not log the token', async () => {
  const calls = [];
  const logs = [];
  const cfg = config();
  const state = { offset: null, timeout: 0 };
  let step = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: options.body });
    assert.equal(String(url).startsWith('https://api.telegram.org/bot'), true);
    step += 1;
    if (step === 1) {
      return jsonResponse({
        ok: true,
        result: [
          update(4242, '/start', 10),
          update(999, 'hallo', 11),
        ],
      });
    }
    return jsonResponse({ ok: true, result: { message_id: step } });
  };
  const sent = await pollTick({ config: cfg, fetchImpl, state, log: (code) => logs.push(code) });
  assert.equal(state.offset, 12);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].chatId, 4242);
  assert.match(sent[0].text, /Erstantwort/);
  assert.equal(sent[0].hasButton, false);
  assert.equal(sent[1].text, CLOSED);
  const outbound = calls.slice(1).map((call) => JSON.parse(call.body));
  assert.equal(outbound[0].text.includes('a@b'), false);
  assert.equal(JSON.stringify(logs).includes(TOKEN), false);
  assert.equal(JSON.stringify(sent).includes(TOKEN), false);
  const stopped = startBotPolling({ config: loadConfig({}) }, fetchImpl);
  assert.equal(stopped, null);
  assert.equal(calls.length, 3);
});
