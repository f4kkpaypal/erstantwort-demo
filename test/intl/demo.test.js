'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const { startIntl } = require('../../engine/intlServer');

test('D23 demo:intl prints the grade line and then stops', async () => {
  const root = path.join(__dirname, '..', '..');
  const child = spawn(process.execPath, ['scripts/demo_intl.js'], {
    cwd: root,
    env: {
      ...process.env,
      DEMO_INTL_EXIT: '1',
      INTL_PORT: '18797',
      HOST: '127.0.0.1',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_ALLOWED_USER_IDS: '',
      PRODUCT_MODE: 'intl',
      CHANNEL_MODE: 'sim',
      REAL_DATA_ALLOWED: 'false',
      DEMO_UI_NO_AUTH: 'false',
      LLM_MODE: 'mock',
    },
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  assert.match(out, /6 HOT \/ 8 WARM \/ 11 COLD/);
});

test('an empty database is seeded once when the intl server starts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-boot-'));
  const started = await startIntl({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'intl-test-salt',
    ENGINE_TOKEN: 'intl-engine-token-0123456789',
    DATA_DIR: dir,
    INTL_PORT: '0',
    HOST: '127.0.0.1',
    REAL_DATA_ALLOWED: 'false',
    DEMO_UI_NO_AUTH: 'false',
    LLM_MODE: 'mock',
    UI_PUBLIC_BASE: 'http://127.0.0.1:9',
    EPHEMERAL_DISK: 'true',
  });
  const leads = started.intl.store.one('SELECT COUNT(*) AS n FROM i_lead').n;
  const viewings = started.intl.store.one('SELECT COUNT(*) AS n FROM i_viewing').n;
  const again = await started.intl.seed(
    JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'intl', 'testset.json'), 'utf8')),
    'all',
  );
  assert.equal(leads, 25);
  assert.equal(viewings, 2);
  assert.deepEqual(again, { HOT: 6, WARM: 8, COLD: 11 });
  assert.equal(started.intl.store.one('SELECT COUNT(*) AS n FROM i_lead').n, 25);
  clearInterval(started.timer);
  await new Promise((resolve) => started.server.close(resolve));
  started.intl.close();
});
