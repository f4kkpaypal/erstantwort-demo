'use strict';

const { runInbound } = require('../core/pipeline');
const { createLlm } = require('../engine/adapters');
const { makeDeps, loadMail } = require('../support/helpers');

async function main() {
  const deps = makeDeps();
  deps.llm = createLlm(deps.config);
  const result = await runInbound(loadMail('E01'), deps);
  const mail = deps.mail.sent[0];
  console.log(`outcome ${result.outcome} grade ${result.grade} score ${result.score} lead ${result.lead_id}`);
  console.log('--- Telegram ---');
  console.log(deps.telegram.messages.join('\n---\n'));
  console.log('--- E-Mail ---');
  if (!mail) {
    console.log('no mail sent');
    return;
  }
  console.log(mail.subject);
  console.log(mail.text);
}

main().catch(() => {
  console.error('demo_failed');
  process.exit(1);
});
