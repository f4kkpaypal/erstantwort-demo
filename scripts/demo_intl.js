'use strict';

const { loadConfig } = require('../core/config');
const { createIntl } = require('../core/intl/service');
const { buildIntlServer } = require('../engine/intlServer');
const { signInitData } = require('../core/uiAuth');
const pack = require('../fixtures/intl/testset.json');

const config = loadConfig({
  ...process.env,
  PRODUCT_MODE: 'intl',
  CHANNEL_MODE: 'sim',
  REAL_DATA_ALLOWED: 'false',
  DEMO_UI_NO_AUTH: 'false',
  LLM_MODE: 'mock',
});
const intl = createIntl(config);
intl.seed(pack, 'all').then((counts) => {
  const server = buildIntlServer(config, intl);
  const port = Number(process.env.INTL_PORT || 8791);
  server.listen(port, '127.0.0.1', () => {
    console.log(`intl_demo http://127.0.0.1:${port}/`);
    console.log(`${counts.HOT} HOT / ${counts.WARM} WARM / ${counts.COLD} COLD`);
    if (process.env.DEMO_INTL_EXIT === '1') {
      server.close();
      intl.close();
      process.exit(0);
    }
    const id = (config.TELEGRAM_ALLOWED_USER_IDS || [])[0];
    if (id && config.TELEGRAM_BOT_TOKEN) {
      const tma = signInitData({
        auth_date: String(Math.floor(Date.now() / 1000)),
        user: JSON.stringify({ id }),
      }, config.TELEGRAM_BOT_TOKEN);
      console.log(`open http://127.0.0.1:${port}/?tma=${encodeURIComponent(tma)}`);
    }
  });
});
