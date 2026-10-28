'use strict';

const { secretConfigured } = require('../core/config');
const { replyToIncoming } = require('../core/telegram');

function pollingEnabled(config) {
  return config?.BOT_POLLING === true
    && config?.TELEGRAM_MODE === 'telegram'
    && secretConfigured(config?.TELEGRAM_BOT_TOKEN);
}

function apiUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function pollTick({ config, fetchImpl, state, signal, log }) {
  const token = config.TELEGRAM_BOT_TOKEN;
  const note = (code) => {
    if (log) log(code);
  };
  const body = { timeout: state.timeout ?? 0, allowed_updates: ['message'] };
  if (state.offset != null) body.offset = state.offset;
  let res;
  try {
    res = await fetchImpl(apiUrl(token, 'getUpdates'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    note('telegram_poll_failed');
    throw Object.assign(new Error('telegram_poll_failed'), { code: 'telegram_poll_failed' });
  }
  if (!res.ok) {
    note('telegram_poll_failed');
    throw Object.assign(new Error('telegram_poll_failed'), { code: 'telegram_poll_failed' });
  }
  const data = await res.json();
  if (!data?.ok || !Array.isArray(data.result)) {
    note('telegram_poll_failed');
    throw Object.assign(new Error('telegram_poll_failed'), { code: 'telegram_poll_failed' });
  }
  const sent = [];
  for (const update of data.result) {
    if (Number.isFinite(update.update_id)) state.offset = update.update_id + 1;
    const reply = replyToIncoming(update, config);
    if (!reply) continue;
    const payload = {
      chat_id: reply.chatId,
      text: reply.text,
      disable_web_page_preview: true,
    };
    if (reply.replyMarkup) payload.reply_markup = reply.replyMarkup;
    try {
      const sentRes = await fetchImpl(apiUrl(token, 'sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      if (!sentRes.ok) note('telegram_reply_failed');
      else sent.push({ chatId: reply.chatId, text: reply.text, hasButton: Boolean(reply.replyMarkup) });
    } catch {
      note('telegram_reply_failed');
    }
  }
  return sent;
}

function startBotPolling(deps, fetchImpl = globalThis.fetch) {
  if (!pollingEnabled(deps?.config)) return null;
  const state = { offset: null, timeout: 25 };
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        await pollTick({
          config: deps.config,
          fetchImpl,
          state,
          signal: AbortSignal.timeout(40000),
          log: (code) => {
            deps.botPollError = code;
          },
        });
        deps.botPollError = '';
      } catch {
        deps.botPollError = 'telegram_poll_failed';
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  };
  loop();
  return () => { stopped = true; };
}

module.exports = { pollingEnabled, pollTick, startBotPolling };
