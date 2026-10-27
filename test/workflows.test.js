'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { writeWorkflows, buildWf01 } = require('../scripts/build_workflows');

const REQUIRED = [
  'Manual Demo E01',
  'Manual Demo E11',
  'N01 IMAP',
  'N00 Strip attachments',
  'N02 Normalize',
  'N03 Dedup',
  'IF Halt',
  'Stop',
  'Switch route',
  'N06 Extract',
  'N07 Validate',
  'N11 Score',
  'WF-03 get_busy',
  'N13 Slots',
  'N14 Compose',
  'N19 Send',
  'WF-02 upsert',
  'N21 Telegram',
  'R01 Match',
  'R02 Classify',
  'Switch reply_action',
  'R-stop',
  'R04–R06 Book',
  'R-human',
];

function walk(workflow) {
  const names = new Set(workflow.nodes.map((node) => node.name));
  const ids = new Set();
  for (const node of workflow.nodes) {
    assert.equal(ids.has(node.id), false, node.id);
    ids.add(node.id);
    assert.equal(names.has(node.name), true);
  }
  assert.equal(ids.size, workflow.nodes.length);
  assert.equal(new Set(workflow.nodes.map((node) => node.name)).size, workflow.nodes.length);
  for (const [from, outputs] of Object.entries(workflow.connections)) {
    assert.equal(names.has(from), true, from);
    for (const port of outputs.main) {
      for (const link of port) assert.equal(names.has(link.node), true, link.node);
    }
  }
}

test('workflow files import as n8n documents', () => {
  const written = writeWorkflows();
  assert.equal(written.length, 5);
  const wf01 = buildWf01();
  const all = [wf01];
  const fs = require('fs');
  const path = require('path');
  for (const name of written) {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'workflows', name), 'utf8');
    const workflow = JSON.parse(raw);
    all.push(workflow);
    assert.equal(workflow.id.length, 16);
    assert.equal(workflow.active, false);
    assert.equal(workflow.settings.timezone, 'Europe/Berlin');
    assert.equal(workflow.settings.executionOrder, 'v1');
    assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
    assert.equal(raw.includes('example.org'), false);
    assert.equal(raw.includes('example.com'), false);
    walk(workflow);
    for (const node of workflow.nodes) {
      if (node.type === 'n8n-nodes-base.httpRequest') {
        assert.equal(node.typeVersion, 4.2);
        assert.equal(node.parameters.url.startsWith('http://engine:8787/v1/'), true, node.name);
        assert.equal(node.parameters.genericAuthType, 'httpHeaderAuth');
        assert.equal(node.credentials.httpHeaderAuth.name, 'Engine Token');
        assert.equal(node.retryOnFail, true);
      }
      if (node.type === 'n8n-nodes-base.code') {
        assert.equal(node.parameters.jsCode.includes('require('), false);
        assert.equal(/\$input|\$now|\$json/.test(node.parameters.jsCode), true);
      }
      if (node.type !== 'n8n-nodes-base.httpRequest') assert.equal(Object.hasOwn(node, 'credentials'), false);
    }
  }
  const intake = all.find((workflow) => workflow.name === 'WF-01 Intake');
  const present = new Set(intake.nodes.map((node) => node.name));
  for (const name of REQUIRED) assert.equal(present.has(name), true, name);
  const imap = intake.nodes.find((node) => node.name === 'N01 IMAP');
  assert.equal(imap.parameters.format, 'resolved');
  assert.equal(imap.parameters.postProcessAction, 'read');
  assert.equal(imap.parameters.options.trackLastMessageId, false);
  assert.equal(imap.parameters.options.customEmailConfig, '["UNSEEN"]');
  const tz = all.find((workflow) => workflow.name === 'WF-00 Timezone');
  const code = tz.nodes.find((node) => node.type === 'n8n-nodes-base.code');
  assert.match(code.parameters.jsCode, /\$now\.zoneName/);
});
