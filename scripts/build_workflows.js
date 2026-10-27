'use strict';

const fs = require('fs');
const path = require('path');

const ENGINE = 'http://engine:8787';
const OUT = path.join(__dirname, '..', 'workflows');

const SETTINGS = {
  timezone: 'Europe/Berlin',
  executionOrder: 'v1',
  saveDataSuccessExecution: 'none',
  saveManualExecutions: true,
  callerPolicy: 'workflowsFromSameOwner',
};

function node(id, name, type, typeVersion, position, parameters) {
  return { id, name, type, typeVersion, position, parameters };
}

function sticky(id, name, position, content, width = 420, height = 220) {
  return node(id, name, 'n8n-nodes-base.stickyNote', 1, position, { content, width, height, color: 4 });
}

function manual(id, name, position) {
  return node(id, name, 'n8n-nodes-base.manualTrigger', 1, position, {});
}

function http(id, name, position, method, urlPath) {
  const parameters = {
    method,
    url: `${ENGINE}${urlPath}`,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    options: { timeout: 120000 },
  };
  if (method === 'POST') {
    parameters.sendBody = true;
    parameters.contentType = 'json';
    parameters.specifyBody = 'json';
    parameters.jsonBody = '={{ JSON.stringify($json) }}';
  }
  const item = node(id, name, 'n8n-nodes-base.httpRequest', 4.2, position, parameters);
  item.retryOnFail = true;
  item.maxTries = 3;
  item.waitBetweenTries = 5000;
  item.credentials = { httpHeaderAuth: { name: 'Engine Token' } };
  return item;
}

function code(id, name, position, jsCode) {
  return node(id, name, 'n8n-nodes-base.code', 2, position, {
    mode: 'runOnceForAllItems',
    language: 'javaScript',
    jsCode,
  });
}

function ifHalt(id, name, position) {
  return node(id, name, 'n8n-nodes-base.if', 2.2, position, {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: [
        {
          id: 'halt-is-true',
          leftValue: '={{ $json.halt }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  });
}

function switchOn(id, name, position, expression, cases) {
  return node(id, name, 'n8n-nodes-base.switch', 3.2, position, {
    rules: {
      values: cases.map((entry) => ({
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: entry.id,
              leftValue: expression,
              rightValue: entry.value,
              operator: { type: 'string', operation: 'equals' },
            },
          ],
          combinator: 'and',
        },
        renameOutput: true,
        outputKey: entry.value,
      })),
    },
    options: { fallbackOutput: 'extra' },
  });
}

function link(connections, from, to, outputIndex = 0) {
  connections[from] = connections[from] || { main: [] };
  while (connections[from].main.length <= outputIndex) connections[from].main.push([]);
  connections[from].main[outputIndex].push({ node: to, type: 'main', index: 0 });
}

function workflow(id, name, nodes, connections) {
  return {
    id,
    name,
    active: false,
    nodes,
    connections,
    settings: SETTINGS,
    staticData: null,
    pinData: {},
    meta: { templateCredsSetupCompleted: true },
  };
}

const STRIP_CODE = `const items = $input.all();
return items.map((item) => {
  const json = { ...item.json };
  let xml = '';
  let other = false;
  const binary = item.binary || {};
  for (const key of Object.keys(binary)) {
    const bin = binary[key] || {};
    const filename = String(bin.fileName || '').toLowerCase();
    const mime = String(bin.mimeType || '').toLowerCase();
    const isXml = filename.endsWith('.xml') || mime.includes('xml');
    if (isXml && bin.data) xml = Buffer.from(bin.data, 'base64').toString('utf8');
    else if (bin.data || bin.fileName) other = true;
  }
  if (xml) json.xml_raw_attachment = xml;
  if (other) json.has_other_attachment = true;
  return { json };
});`;

const VALIDATE_CODE = `const items = $input.all();
return items.map((item) => ({
  json: {
    ...item.json,
    validated: item.json.halt !== true && Boolean(item.json.lead),
  },
}));`;

const TIMEZONE_CODE = `return [{ json: { iso: $now.toISO(), zone: $now.zoneName, offsetName: $now.offsetNameShort } }];`;

function buildWf00() {
  const nodes = [
    manual('wf00-manual', 'Manual Timezone', [0, 200]),
    code('wf00-code', 'L01 Timezone', [280, 200], TIMEZONE_CODE),
    sticky('wf00-note', 'Hinweis Zeitzone', [0, 0], 'Проверка L01. В выходе zone должно быть Europe/Berlin, а время — берлинское. Если zone другое, у контейнера n8n не задан GENERIC_TIMEZONE.'),
  ];
  const connections = {};
  link(connections, 'Manual Timezone', 'L01 Timezone');
  return workflow('Wf00TimezoneChck', 'WF-00 Timezone', nodes, connections);
}

function buildWf01() {
  const nodes = [
    sticky('wf01-note', 'Hinweis Loom', [0, -20], [
      'Loom-срез. Активируйте только этот workflow.',
      'IMAP-credential «IMAP Makler» повесьте на N01 после импорта. Папку Autopilot, если она есть, укажите в mailbox.',
      'Manual Demo E01 и E11 идут в движок без почты. Сначала E01, потом E11.',
      'Черновик ничего не отправляет, пока SEND_MODE не auto. В Telegram нет имени, почты и телефона.',
    ].join('\n'), 520, 180),
    manual('wf01-e01', 'Manual Demo E01', [0, 220]),
    http('wf01-get-e01', 'GET Demo E01', [260, 220], 'GET', '/v1/demo/fixture/E01'),
    manual('wf01-e11', 'Manual Demo E11', [0, 400]),
    http('wf01-get-e11', 'GET Demo E11', [260, 400], 'GET', '/v1/demo/fixture/E11'),
    node('wf01-imap', 'N01 IMAP', 'n8n-nodes-base.emailReadImap', 2.2, [0, 600], {
      mailbox: 'INBOX',
      postProcessAction: 'read',
      format: 'resolved',
      options: {
        customEmailConfig: '["UNSEEN"]',
        trackLastMessageId: false,
      },
    }),
    code('wf01-strip', 'N00 Strip attachments', [280, 600], STRIP_CODE),
    http('wf01-n02', 'N02 Normalize', [560, 400], 'POST', '/v1/step/normalize'),
    http('wf01-n03', 'N03 Dedup', [820, 400], 'POST', '/v1/step/dedup'),
    ifHalt('wf01-if', 'IF Halt', [1080, 400]),
    node('wf01-stop', 'Stop', 'n8n-nodes-base.noOp', 1, [1340, 220], {}),
    switchOn('wf01-route', 'Switch route', [1340, 460], '={{ $json.route }}', [
      { id: 'route-inquiry', value: 'inquiry' },
      { id: 'route-reply', value: 'reply' },
    ]),
    http('wf01-n06', 'N06 Extract', [1640, 280], 'POST', '/v1/step/extract'),
    code('wf01-n07', 'N07 Validate', [1900, 280], VALIDATE_CODE),
    http('wf01-n11', 'N11 Score', [2140, 280], 'POST', '/v1/step/score'),
    http('wf01-busy', 'WF-03 get_busy', [2400, 280], 'POST', '/v1/step/busy'),
    http('wf01-n13', 'N13 Slots', [2660, 280], 'POST', '/v1/step/slots'),
    http('wf01-n14', 'N14 Compose', [2920, 280], 'POST', '/v1/step/compose'),
    http('wf01-n19', 'N19 Send', [3180, 280], 'POST', '/v1/step/send'),
    http('wf01-crm', 'WF-02 upsert', [3440, 280], 'POST', '/v1/step/crm'),
    http('wf01-n21', 'N21 Telegram', [3700, 280], 'POST', '/v1/step/telegram'),
    http('wf01-r01', 'R01 Match', [1640, 620], 'POST', '/v1/step/reply/match'),
    http('wf01-r02', 'R02 Classify', [1900, 620], 'POST', '/v1/step/reply/classify'),
    switchOn('wf01-raction', 'Switch reply_action', [2160, 620], '={{ $json.reply_action }}', [
      { id: 'action-stop', value: 'stop' },
      { id: 'action-book', value: 'book' },
    ]),
    http('wf01-rstop', 'R-stop', [2480, 520], 'POST', '/v1/step/reply/stop'),
    http('wf01-rbook', 'R04–R06 Book', [2480, 680], 'POST', '/v1/step/reply/book'),
    http('wf01-rhuman', 'R-human', [2480, 840], 'POST', '/v1/step/reply/human'),
  ];
  const connections = {};
  link(connections, 'Manual Demo E01', 'GET Demo E01');
  link(connections, 'GET Demo E01', 'N02 Normalize');
  link(connections, 'Manual Demo E11', 'GET Demo E11');
  link(connections, 'GET Demo E11', 'N02 Normalize');
  link(connections, 'N01 IMAP', 'N00 Strip attachments');
  link(connections, 'N00 Strip attachments', 'N02 Normalize');
  link(connections, 'N02 Normalize', 'N03 Dedup');
  link(connections, 'N03 Dedup', 'IF Halt');
  link(connections, 'IF Halt', 'Stop', 0);
  link(connections, 'IF Halt', 'Switch route', 1);
  link(connections, 'Switch route', 'N06 Extract', 0);
  link(connections, 'Switch route', 'R01 Match', 1);
  link(connections, 'Switch route', 'Stop', 2);
  link(connections, 'N06 Extract', 'N07 Validate');
  link(connections, 'N07 Validate', 'N11 Score');
  link(connections, 'N11 Score', 'WF-03 get_busy');
  link(connections, 'WF-03 get_busy', 'N13 Slots');
  link(connections, 'N13 Slots', 'N14 Compose');
  link(connections, 'N14 Compose', 'N19 Send');
  link(connections, 'N19 Send', 'WF-02 upsert');
  link(connections, 'WF-02 upsert', 'N21 Telegram');
  link(connections, 'R01 Match', 'R02 Classify');
  link(connections, 'R02 Classify', 'Switch reply_action');
  link(connections, 'Switch reply_action', 'R-stop', 0);
  link(connections, 'Switch reply_action', 'R04–R06 Book', 1);
  link(connections, 'Switch reply_action', 'R-human', 2);
  return workflow('Wf01IntakeLoom01', 'WF-01 Intake', nodes, connections);
}

function buildWf02() {
  const nodes = [
    manual('wf02-manual', 'Manual CRM contract', [0, 220]),
    http('wf02-get', 'CRM contract', [300, 220], 'GET', '/v1/crm/contract'),
    sticky('wf02-note', 'Hinweis CRM', [0, 0], 'Этот срез пишет лид в Google Sheet «Ihr CRM (Demo)». Propstack — первый следующий CRM и здесь отвечает NOT_IMPLEMENTED. Секреты Google лежат в .env движка, не в n8n.'),
  ];
  const connections = {};
  link(connections, 'Manual CRM contract', 'CRM contract');
  return workflow('Wf02SheetCrmDemo', 'WF-02 CRM', nodes, connections);
}

function buildWf03() {
  const nodes = [
    manual('wf03-manual', 'Manual Calendar contract', [0, 220]),
    http('wf03-get', 'Calendar contract', [320, 220], 'GET', '/v1/calendar/contract'),
    sticky('wf03-note', 'Hinweis Kalender', [0, 0], 'Свободные окна считает движок. В событии только «Besichtigung {ID} · {Lead}», без имени и контактов. WF-01 вызывает тот же шаг узлом WF-03 get_busy.'),
  ];
  const connections = {};
  link(connections, 'Manual Calendar contract', 'Calendar contract');
  return workflow('Wf03CalendarBusy', 'WF-03 Calendar', nodes, connections);
}

function buildWf06() {
  const nodes = [
    manual('wf06-manual', 'Manual Reply E11', [0, 240]),
    http('wf06-get', 'GET Demo E11', [280, 240], 'GET', '/v1/demo/fixture/E11'),
    http('wf06-run', 'Intake run', [560, 240], 'POST', '/v1/intake/run'),
    sticky('wf06-note', 'Hinweis Antwort', [0, 0], 'Не активируйте WF-06 вместе с WF-01: оба не должны читать IMAP. Сначала прогоните E01 в WF-01, затем это ручное повторение ответа «Nr. 2». Если demo_state пуст, движок вернёт demo_state_missing.'),
  ];
  const connections = {};
  link(connections, 'Manual Reply E11', 'GET Demo E11');
  link(connections, 'GET Demo E11', 'Intake run');
  return workflow('Wf06ReplyHandler', 'WF-06 Reply', nodes, connections);
}

function writeWorkflows() {
  const files = {
    'WF-00-timezone.json': buildWf00(),
    'WF-01-intake.json': buildWf01(),
    'WF-02-crm.json': buildWf02(),
    'WF-03-calendar.json': buildWf03(),
    'WF-06-reply.json': buildWf06(),
  };
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(body, null, 2)}\n`);
  }
  return Object.keys(files);
}

if (require.main === module) {
  const written = writeWorkflows();
  console.log(written.join('\n'));
}

module.exports = { writeWorkflows, buildWf00, buildWf01, buildWf02, buildWf03, buildWf06 };
