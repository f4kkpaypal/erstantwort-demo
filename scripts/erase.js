'use strict';

const { loadConfig } = require('../core/config');
const { eraseSubject } = require('../core/erase');
const { createRuntime } = require('../engine/adapters');

async function main() {
  const email = process.argv[2] || '';
  const deps = await createRuntime(loadConfig(process.env));
  const result = await eraseSubject(deps, email);
  if (!result.ok) {
    console.error(`erase_failed ${result.error}`);
    process.exit(1);
  }
  console.log(`erase_ok leads=${result.leads} optout=kept`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`erase_failed ${err.code || 'error'}`);
    process.exit(1);
  });
}

module.exports = { main };
