'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../core/config');
const { MemoryStore } = require('../core/store');
const { MemoryCrm } = require('../core/crm');
const { loadFixtureEml } = require('../core/eml');

const OBJEKTE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'objekte.json'), 'utf8'));
const LLM = {
  E01: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'llm', 'E01.json'), 'utf8')),
  E02: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'llm', 'E02.json'), 'utf8')),
};

const CLOCK = () => new Date('2026-10-21T10:00:00.000Z');

function testConfig(overrides = {}) {
  return loadConfig({
    SEND_MODE: 'auto',
    HASH_SALT: 'test-salt',
    ENGINE_TOKEN: 'test-engine-token-0123456789',
    GENERIC_TIMEZONE: 'Europe/Berlin',
    MAIL_DOMAIN: 'lead.testdomain.de',
    RETENTION_DAYS_LEAD: '180',
    FOLLOWUP_EMAIL_ENABLED: 'false',
    NOSHOW_REOFFER_ENABLED: 'false',
    INTERESSE_FOLLOWUP_ENABLED: 'false',
    APPROVAL_TIMEOUT_ACTION: 'remind',
    MAX_REPLIES_PER_HOUR: '30',
    FIRST_RESPONSE_SLA_SECONDS: '300',
    MAKLER_PROFILE: JSON.stringify({
      name: 'Alex Berger',
      buero: 'Berger Immobilien',
      adresse: 'Musterstraße 1, 10115 Berlin',
      telefon: '+49 30 0000000',
      impressum_url: 'https://berger.test/impressum',
      datenschutz_url: 'https://berger.test/datenschutz',
      from_email: 'makler@lead.testdomain.de',
      from_name: 'Alex Berger',
      sheet_url: 'https://docs.google.com/spreadsheets/d/demo',
    }),
    ...overrides,
  });
}

function mockCalendar(seed = []) {
  return {
    events: seed.map((row) => ({ ...row })),
    async getBusy() {
      return this.events.map((row) => ({ start: row.start, end: row.end }));
    },
    async createEvent(event) {
      const event_id = `evt-${this.events.length + 1}`;
      this.events.push({ ...event, event_id });
      return { event_id };
    },
    async deleteEvent(eventId) {
      this.events = this.events.filter((row) => row.event_id !== eventId);
    },
    async updateForLead(leadId, patch) {
      let n = 0;
      for (const event of this.events) {
        const title = String(event.title || '');
        if (!title.includes(leadId)) continue;
        if (patch.start) event.start = patch.start;
        if (patch.end) event.end = patch.end;
        n += 1;
      }
      return n;
    },
    async deleteForLead(leadId) {
      const before = this.events.length;
      this.events = this.events.filter((event) => !String(event.title || '').includes(leadId));
      return before - this.events.length;
    },
  };
}

function makeDeps({ config, llmFixture, llm, busy } = {}) {
  const resolved = config || testConfig();
  const calls = [];
  const data = llmFixture ? LLM[llmFixture] : null;
  const llmFn = llm || (async (request) => {
    calls.push(request);
    const name = request.response_format.json_schema.name;
    if (!data) throw new Error('no_llm_fixture');
    if (name === 'lead_extraction') return { content: JSON.stringify(data.extraction), model: 'mock', tokens_in: 10, tokens_out: 10 };
    if (name === 'reply_body') return { content: JSON.stringify(data.reply), model: 'mock', tokens_in: 8, tokens_out: 8 };
    throw new Error(`unexpected_schema_${name}`);
  });
  const mail = { sent: [], async send(message) { this.sent.push(message); } };
  const telegram = { messages: [], async send(text) { this.messages.push(text); } };
  const logs = [];
  return {
    config: resolved,
    clock: CLOCK,
    db: new MemoryStore(),
    crm: new MemoryCrm(),
    calendar: mockCalendar(busy),
    mail,
    telegram,
    objekte: OBJEKTE,
    llm: llmFn,
    llmCalls: calls,
    logs,
    async log(event) { logs.push(event); },
  };
}

function loadMail(id) {
  return loadFixtureEml(id);
}

module.exports = {
  OBJEKTE,
  LLM,
  CLOCK,
  testConfig,
  makeDeps,
  loadMail,
  mockCalendar,
};
