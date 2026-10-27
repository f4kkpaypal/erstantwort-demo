'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sha256 } = require('./hash');
const { scoreLead } = require('./score');
const { AI_FIRST_LINE } = require('./template');

const TIMELINE_OPTIONS = [
  { value: 'bis_3_monate', label: 'In den nächsten 3 Monaten' },
  { value: '3_bis_6_monate', label: 'In 3 bis 6 Monaten' },
  { value: 'ueber_6_monate', label: 'Später' },
  { value: 'unbekannt', label: 'Noch offen' },
];

const FINANCING_OPTIONS = [
  { value: 'barzahler', label: 'Barzahlung' },
  { value: 'finanzierungszusage', label: 'Finanzierungszusage liegt vor' },
  { value: 'in_pruefung', label: 'Finanzierung in Prüfung' },
  { value: 'nicht_geklaert', label: 'Noch nicht geklärt' },
  { value: 'unbekannt', label: 'Keine Angabe' },
];

const EQUITY_OPTIONS = [
  { value: 'unter_10', label: 'unter 10 %' },
  { value: '10_20', label: '10–20 %' },
  { value: 'ab_20', label: '20 % oder mehr' },
  { value: 'keine', label: 'Keine Angabe' },
];

const PERSON_OPTIONS = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
  { value: '5+', label: '5 oder mehr' },
  { value: 'keine', label: 'Keine Angabe' },
];

function flagsFrom(config) {
  return {
    budget: config?.FRAGEBOGEN_BUDGET_ENABLED === true,
    income: config?.FRAGEBOGEN_INCOME_ENABLED === true,
    persons: config?.FRAGEBOGEN_PERSONS_ENABLED === true,
    schufa: config?.FRAGEBOGEN_SCHUFA_ENABLED === true,
    employment: config?.FRAGEBOGEN_EMPLOYMENT_ENABLED === true,
  };
}

function brokerUrl(url, path, config) {
  const base = String(config?.UI_PUBLIC_BASE || 'http://127.0.0.1:18791').replace(/\/$/, '');
  if (!url || /REPLACE_ME/i.test(String(url))) return `${base}${path}`;
  return url;
}

function incomeThresholds(kalt) {
  const base = Number(kalt);
  if (!Number.isFinite(base) || base <= 0) return null;
  return {
    low: Math.round(base * 2.5),
    high: Math.round(base * 3),
  };
}

function euro(value) {
  return new Intl.NumberFormat('de-DE').format(value);
}

function isEmpty(value) {
  return value == null || value === '' || value === 'unbekannt';
}

function asBool(value) {
  return value === true || value === 'true' || value === 'ja' || value === '1';
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function scoreInput(row, objekt, extra = {}) {
  const owner = row.lead_kind === 'eigentuemer';
  return {
    lead_kind: owner ? 'eigentuemer' : undefined,
    object_type: owner ? row.object_type : undefined,
    city: owner ? row.object_city : undefined,
    district: owner ? row.object_district : undefined,
    area_sqm: owner ? row.area_sqm : undefined,
    valuation_requested: owner ? row.valuation_requested === true : undefined,
    inquiry_type: row.inquiry_type,
    financing_status: row.financing_status || 'unbekannt',
    budget_max_eur: row.budget_max_eur === '' || row.budget_max_eur == null ? null : Number(row.budget_max_eur),
    price_eur: objekt?.price_eur ?? null,
    warmmiete_eur: objekt?.warmmiete_eur ?? null,
    kaltmiete_eur: objekt?.kaltmiete_eur ?? null,
    equity_eur: row.equity_eur === '' || row.equity_eur == null ? null : Number(row.equity_eur),
    income_min_eur: extra.income_min_eur ?? null,
    schufa_available: extra.schufa_available || 'unbekannt',
    timeline_horizon: row.timeline_horizon || 'unbekannt',
    viewing_requested: asBool(row.viewing_requested),
    phone: row.phone || '',
    questions: asList(row.questions),
    missing_fields: asList(row.missing_fields),
    injection_suspected: asBool(row.injection_suspected),
  };
}

function formatSummaryLine(label, value) {
  const name = String(label || '').trim();
  const shown = String(value ?? '').trim();
  if (!name) return shown;
  if (name.endsWith('?')) return `${name} — ${shown}`;
  if (name.endsWith(':')) return `${name} ${shown}`;
  return `${name}: ${shown}`;
}

const OWNER_TYPES = [
  { value: 'wohnung', label: 'Wohnung' },
  { value: 'haus', label: 'Haus' },
  { value: 'grundstueck', label: 'Grundstück' },
  { value: 'gewerbe', label: 'Gewerbe' },
];

const SALE_OPTIONS = [
  { value: 'bis_3_monate', label: 'In den nächsten 3 Monaten' },
  { value: '3_bis_6_monate', label: 'In 3 bis 6 Monaten' },
  { value: 'ueber_6_monate', label: 'Später' },
  { value: 'unbekannt', label: 'Noch offen' },
];

function privacyText({ makler, config, title, flags }) {
  const name = makler?.name || 'Ihr Makler';
  const buero = makler?.buero || name;
  const retention = config?.RETENTION_DAYS_LEAD || 180;
  const incomeSentence = flags?.income
    ? ' Ihr genaues Einkommen speichern wir nicht, nur ob es im Verhältnis zur Miete passt.'
    : '';
  const datenschutzUrl = brokerUrl(makler?.datenschutz_url, '/datenschutz', config);
  const modelSentence = config?.LLM_MODE === 'live'
    ? ' Ist ein Sprachmodell eingeschaltet, verarbeitet der in der Auftragsverarbeitung genannte Anbieter den Text der Anfrage.'
    : ' In der Grundeinstellung verlässt der Anfragetext diesen Server nicht.';
  return `Verantwortlich ist ${buero}, ${makler?.adresse || ''}. Wir verarbeiten Ihre Angaben, um Ihre Anfrage zu ${title || 'dieser Immobilie'} zu bearbeiten und zu priorisieren (Art. 6 Abs. 1 lit. b und f DSGVO). Ihre Angaben werden nach festen Regeln automatisch eingeordnet; daraus folgt keine automatische Absage, die Entscheidung trifft ${name} persönlich. Alle Angaben sind freiwillig.${incomeSentence} Ihre Daten werden nach ${retention} Tagen gelöscht, früher auf Wunsch. Ein Widerspruch per STOP bleibt auch danach gespeichert, damit keine neue automatische Nachricht an dieselbe Adresse geht. Gespeichert wird dafür nur ein Prüfwert, nicht die Adresse im Klartext. Sie können jederzeit widersprechen (Antwort „STOP" auf unsere E-Mail). Technischer Dienstleister: Betrieb der Automatisierung.${modelSentence} Mehr: ${datenschutzUrl}`;
}

function areaQuestion(type) {
  if (type === 'haus') return 'Ungefähre Wohnfläche des Hauses in m²';
  if (type === 'grundstueck') return 'Ungefähre Grundstücksfläche in m²';
  if (type === 'wohnung') return 'Ungefähre Wohnfläche der Wohnung in m²';
  return 'Ungefähre Fläche in m²';
}

function ownerSchema({ lead, makler, config }) {
  const flags = flagsFrom(config);
  const name = makler?.name || 'Ihr Makler';
  const title = lead?.listing_title || 'Ihre Immobilie';
  return {
    steps: [
      {
        id: 1,
        title: 'Ihre Immobilie',
        fields: [
          { name: 'ansprache', label: 'Wie dürfen wir Sie ansprechen?', type: 'text', maxLength: 60, optional: true },
          { name: 'object_place', label: 'Adresse oder Stadtteil des Objekts', type: 'text', maxLength: 120, optional: true },
          { name: 'object_type', label: 'Um welche Immobilie geht es?', type: 'select', optional: true, options: OWNER_TYPES },
          {
            name: 'area_sqm',
            label: areaQuestion(lead?.object_type),
            type: 'number',
            optional: true,
            area_labels: {
              haus: areaQuestion('haus'),
              grundstueck: areaQuestion('grundstueck'),
              wohnung: areaQuestion('wohnung'),
              gewerbe: areaQuestion('gewerbe'),
            },
          },
        ],
      },
      {
        id: 2,
        title: 'Verkauf und Termin',
        fields: [
          { name: 'timeline', label: 'Wann möchten Sie verkaufen?', type: 'select', optional: true, options: SALE_OPTIONS },
          { name: 'preferred_days', label: 'Welche Tage passen Ihnen für einen Bewertungstermin?', type: 'text', maxLength: 120, optional: true },
          { name: 'phone', label: 'Telefon für die Terminabstimmung', type: 'text', maxLength: 40, optional: true },
        ],
      },
      { id: 3, title: 'Datenschutz und Absenden', fields: [] },
    ],
    flags,
    inquiry_type: 'eigentuemer',
    lead_kind: 'eigentuemer',
    listing_title: title,
    makler_name: name,
    transparency: `Ihre Angaben werden automatisch nach festen Regeln eingeordnet, damit ${name} Verkaufsanfragen schneller bearbeiten kann. Über den Bewertungstermin entscheiden Sie gemeinsam.`,
    datenschutz: privacyText({ makler, config, title, flags: { income: false } }),
    ai_line: AI_FIRST_LINE,
    question_count: 7,
    prompt_line: `${name} hat ein paar Fragen zu Ihrer Immobilie vorbereitet.`,
  };
}

function formSchema({ lead, objekt, makler, config }) {
  if (lead?.lead_kind === 'eigentuemer') return ownerSchema({ lead, makler, config });
  const flags = flagsFrom(config);
  const miete = lead?.inquiry_type !== 'kauf';
  const bands = incomeThresholds(objekt?.kaltmiete_eur);
  const incomeOptions = bands ? [
    { value: 'unter', label: `unter ${euro(bands.low)} €` },
    { value: 'mittel', label: `${euro(bands.low)} € bis ${euro(bands.high - 1)} €` },
    { value: 'hoch', label: `${euro(bands.high)} € oder mehr` },
    { value: 'keine', label: 'Keine Angabe' },
  ] : [];
  const step1Fields = [
    { name: 'ansprache', label: 'Wie dürfen wir Sie ansprechen?', type: 'text', maxLength: 60, optional: true },
    {
      name: 'timeline',
      label: miete ? 'Ab wann möchten Sie einziehen?' : 'Wann möchten Sie kaufen?',
      type: 'select',
      optional: true,
      options: TIMELINE_OPTIONS,
    },
  ];
  if (!miete || flags.budget) {
    step1Fields.push({
      name: 'budget_eur',
      label: miete ? 'Ihr Budget pro Monat (warm), €' : 'Ihr maximaler Kaufpreis, €',
      type: 'number',
      optional: true,
    });
  }
  const step1 = { id: 1, title: 'Über Sie', fields: step1Fields };
  const step2Fields = [];
  if (miete) {
    step2Fields.push({
      name: 'intent',
      label: 'Wie möchten Sie weitermachen?',
      type: 'radio',
      optional: true,
      options: [
        { value: 'besichtigen', label: 'Ich möchte die Wohnung zuerst besichtigen.' },
        { value: 'anmieten', label: 'Ich möchte die Wohnung nach jetzigem Stand anmieten.' },
      ],
    });
    if (flags.persons) {
      step2Fields.push({
        name: 'persons',
        label: 'Wie viele Personen sollen einziehen?',
        type: 'select',
        optional: true,
        when: 'anmieten',
        options: PERSON_OPTIONS,
        note: 'Diese Angabe wird nicht gespeichert.',
      });
    }
    if (flags.income && incomeOptions.length) {
      step2Fields.push({
        name: 'income_band',
        label: 'Monatliches Haushaltsnettoeinkommen',
        type: 'select',
        optional: true,
        when: 'anmieten',
        options: incomeOptions,
      });
    }
    if (flags.employment) {
      step2Fields.push({
        name: 'employment',
        label: 'Beschäftigungsart',
        type: 'select',
        optional: true,
        when: 'anmieten',
        options: [
          { value: 'angestellt', label: 'Angestellt' },
          { value: 'selbststaendig', label: 'Selbstständig' },
          { value: 'beamtet', label: 'Beamtet' },
          { value: 'ausbildung', label: 'In Ausbildung / Studium' },
          { value: 'rente', label: 'Rente / Pension' },
          { value: 'sonstiges', label: 'Sonstiges' },
          { value: 'keine', label: 'Keine Angabe' },
        ],
      });
    }
    if (flags.schufa) {
      step2Fields.push({
        name: 'schufa',
        label: 'Liegt Ihnen eine aktuelle SCHUFA-Auskunft vor?',
        type: 'select',
        optional: true,
        when: 'anmieten',
        options: [
          { value: 'ja', label: 'Ja' },
          { value: 'nein', label: 'Nein' },
          { value: 'keine', label: 'Keine Angabe' },
        ],
        note: 'Bitte jetzt nichts hochladen.',
      });
    }
  } else {
    step2Fields.push(
      { name: 'financing', label: 'Wie ist Ihre Finanzierung?', type: 'select', optional: true, options: FINANCING_OPTIONS },
      { name: 'equity_band', label: 'Eigenkapital im Verhältnis zum Kaufpreis', type: 'select', optional: true, options: EQUITY_OPTIONS },
    );
  }
  const name = makler?.name || 'Ihr Makler';
  return {
    steps: [
      step1,
      { id: 2, title: miete ? 'Ihr Anmietungsinteresse' : 'Finanzierung', fields: step2Fields },
      { id: 3, title: 'Datenschutz und Absenden', fields: [] },
    ],
    flags,
    inquiry_type: miete ? 'miete' : 'kauf',
    listing_title: lead?.listing_title || objekt?.title || '',
    makler_name: name,
    transparency: `Ihre Angaben werden automatisch nach festen Regeln eingeordnet, damit ${name} Anfragen schneller bearbeiten kann. Über Besichtigung und Vermietung entscheidet ${name} persönlich.`,
    datenschutz: privacyText({
      makler,
      config,
      title: lead?.listing_title || objekt?.title || 'dieser Immobilie',
      flags,
    }),
    ai_line: AI_FIRST_LINE,
    prompt_line: `${name} hat ein paar Fragen zu dieser Immobilie vorbereitet.`,
    question_count: step1.fields.length + step2Fields.length,
  };
}

function applyOwnerForm({ lead, answers }) {
  const src = answers || {};
  const next = { ...lead, lead_kind: 'eigentuemer', missing_fields: asList(lead.missing_fields).slice() };
  const stored = {};
  if (src.ansprache) stored.ansprache = String(src.ansprache).trim().slice(0, 60);
  if (src.object_place) {
    stored.object_place = String(src.object_place).trim().slice(0, 120);
    next.object_district = stored.object_place;
    next.missing_fields = next.missing_fields.filter((field) => field !== 'district');
  }
  if (OWNER_TYPES.some((row) => row.value === src.object_type)) {
    stored.object_type = src.object_type;
    next.object_type = src.object_type;
    next.missing_fields = next.missing_fields.filter((field) => field !== 'object_type');
  }
  if (src.area_sqm != null && src.area_sqm !== '') {
    const area = Number(src.area_sqm);
    if (Number.isFinite(area) && area > 0) {
      stored.area_sqm = area;
      next.area_sqm = area;
      next.missing_fields = next.missing_fields.filter((field) => field !== 'area');
    }
  }
  if (src.timeline && SALE_OPTIONS.some((row) => row.value === src.timeline)) {
    stored.timeline = src.timeline;
    next.timeline_horizon = src.timeline;
    next.missing_fields = next.missing_fields.filter((field) => field !== 'timeline');
  }
  if (src.preferred_days) {
    stored.preferred_days = String(src.preferred_days).trim().slice(0, 120);
    next.preferred_days = stored.preferred_days;
    next.valuation_requested = true;
  }
  if (src.phone) {
    stored.phone = String(src.phone).trim().slice(0, 40);
    next.phone = stored.phone;
    next.missing_fields = next.missing_fields.filter((field) => field !== 'phone');
  }
  next.missing_fields = next.missing_fields.filter((field) => !['budget', 'financing', 'income'].includes(field));
  const scoreBase = {
    lead_kind: 'eigentuemer',
    object_type: next.object_type,
    city: next.object_city,
    district: next.object_district,
    area_sqm: next.area_sqm,
    timeline_horizon: next.timeline_horizon,
    valuation_requested: next.valuation_requested === true,
    phone: next.phone,
  };
  const before = scoreLead(scoreInput(lead, null));
  const after = scoreLead({ ...scoreBase, lead_kind: 'eigentuemer' });
  next.score = after.score;
  next.grade = after.grade;
  next.reasons = after.reasons;
  next.signals = after.signals;
  next.fragebogen_status = 'submitted';
  next.score_before = before.score;
  next.grade_before = before.grade;
  delete next.income_min_eur;
  delete next.income_band_eur;
  delete next.schufa_available;
  delete next.persons_count;
  delete next.pets;
  return { lead: next, before, after, abweichungen: [], answers: stored };
}

function applyFragebogen({ lead, objekt, answers, config }) {
  if (lead?.lead_kind === 'eigentuemer') return applyOwnerForm({ lead, answers });
  const flags = flagsFrom(config);
  const src = answers || {};
  const next = { ...lead, missing_fields: asList(lead.missing_fields).slice() };
  const stored = {};
  const abweichungen = [];
  const miete = lead.inquiry_type !== 'kauf';
  const phaseB = !miete || src.intent === 'anmieten';

  if (src.ansprache) stored.ansprache = String(src.ansprache).trim().slice(0, 60);
  if (src.timeline && TIMELINE_OPTIONS.some((row) => row.value === src.timeline)) {
    stored.timeline = src.timeline;
    if (isEmpty(lead.timeline_horizon)) {
      next.timeline_horizon = src.timeline;
      next.missing_fields = next.missing_fields.filter((field) => field !== 'timeline');
    } else if (lead.timeline_horizon !== src.timeline && src.timeline !== 'unbekannt') {
      abweichungen.push(`Abweichung: Fragebogen nennt Zeitraum ${src.timeline}, Anfrage ${lead.timeline_horizon}`);
    }
  }
  const allowBudget = !miete || flags.budget;
  if (allowBudget && src.budget_eur != null && src.budget_eur !== '') {
    const budget = Number(src.budget_eur);
    if (Number.isFinite(budget) && budget >= 0) {
      stored.budget_eur = budget;
      if (lead.budget_max_eur == null || lead.budget_max_eur === '') {
        next.budget_max_eur = budget;
        next.missing_fields = next.missing_fields.filter((field) => field !== 'budget');
      } else if (Number(lead.budget_max_eur) !== budget) {
        abweichungen.push(`Abweichung: Fragebogen nennt Budget ${budget} €, Anfrage ${lead.budget_max_eur} €`);
      }
    }
  }
  if (src.intent === 'besichtigen' || src.intent === 'anmieten') stored.intent = src.intent;

  let incomeMin = null;
  if (flags.income && phaseB && miete && src.income_band) {
    const bands = incomeThresholds(objekt?.kaltmiete_eur);
    if (bands && src.income_band === 'hoch') incomeMin = bands.high;
    else if (bands && src.income_band === 'mittel') incomeMin = bands.low;
    else if (src.income_band === 'unter') incomeMin = 0;
    if (['hoch', 'mittel', 'unter', 'keine'].includes(src.income_band)) stored.income_band = src.income_band;
  }
  if (!miete && src.financing && FINANCING_OPTIONS.some((row) => row.value === src.financing)) {
    stored.financing = src.financing;
    if (isEmpty(lead.financing_status)) {
      next.financing_status = src.financing;
      next.missing_fields = next.missing_fields.filter((field) => field !== 'financing');
    }
  }
  if (!miete && src.equity_band && (lead.equity_eur == null || lead.equity_eur === '') && objekt?.price_eur) {
    const ratio = { unter_10: 0.05, '10_20': 0.1, ab_20: 0.2 }[src.equity_band];
    if (ratio != null) {
      next.equity_eur = Math.round(Number(objekt.price_eur) * ratio);
      stored.equity_band = src.equity_band;
    }
  }
  if (miete && !flags.budget) {
    next.missing_fields = next.missing_fields.filter((field) => field !== 'budget');
  }
  if (flags.employment && phaseB && src.employment && src.employment !== 'keine') {
    stored.employment_type = String(src.employment).slice(0, 40);
    next.employment_type = stored.employment_type;
  }

  let schufa = 'unbekannt';
  if (flags.schufa && phaseB && (src.schufa === 'ja' || src.schufa === 'nein')) schufa = src.schufa;

  const before = scoreLead(scoreInput(lead, objekt));
  const after = scoreLead(scoreInput(next, objekt, { income_min_eur: incomeMin, schufa_available: schufa }));
  next.score = after.score;
  next.grade = after.grade;
  next.reasons = after.reasons;
  next.income_ok_flag = after.income_ok_flag;
  next.equity_ratio_band = after.equity_ratio_band;
  next.signals = after.signals;
  next.fragebogen_status = 'submitted';
  next.score_before = before.score;
  next.grade_before = before.grade;
  delete next.income_min_eur;
  delete next.income_band_eur;
  delete next.schufa_available;
  delete next.persons_count;
  delete next.pets;
  delete stored.persons;
  delete stored.pets;
  delete stored.schufa;
  return { lead: next, before, after, abweichungen, answers: stored };
}

function tokenHash(token, salt) {
  return sha256(`${salt}\nfragebogen\n${token}`);
}

class FragebogenStore {
  constructor({ salt, publicBase, linkDays, now, file }) {
    this.salt = salt || 'dev-only-change-me';
    this.publicBase = publicBase || 'http://127.0.0.1:18791';
    this.linkDays = linkDays || 14;
    this.now = now || (() => new Date());
    this.file = file || '';
    this.rows = new Map();
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(saved)) {
        for (const row of saved) {
          if (row?.token_hash) this.rows.set(row.token_hash, row);
        }
      }
    } catch {
      // A missing file is a new office.
    }
  }

  flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.rows.values()]));
    fs.renameSync(tmp, this.file);
  }

  issue({ leadId, email, listingId, token }) {
    const raw = token || crypto.randomBytes(16).toString('hex');
    const hash = tokenHash(raw, this.salt);
    const created = this.now();
    const expires = new Date(created.getTime() + this.linkDays * 24 * 60 * 60 * 1000);
    if (!this.rows.has(hash)) {
      this.rows.set(hash, {
        token_hash: hash,
        lead_id: leadId,
        listing_id: listingId || '',
        email_hash: email ? sha256(`${this.salt}\n${String(email).trim().toLowerCase()}`) : '',
        expires_at: expires.toISOString(),
        opened_at: '',
        submitted_at: '',
        answers: null,
        revoked: false,
      });
    }
    this.flush();
    return { token: raw, url: `${this.publicBase}/f/${raw}`, expires_at: this.rows.get(hash).expires_at };
  }

  find(token) {
    const row = this.rows.get(tokenHash(token, this.salt));
    return row ? { ...row, answers: row.answers ? { ...row.answers } : null } : null;
  }

  markOpened(token) {
    const row = this.rows.get(tokenHash(token, this.salt));
    if (row && !row.opened_at) {
      row.opened_at = this.now().toISOString();
      this.flush();
    }
  }

  save(token, patch) {
    const row = this.rows.get(tokenHash(token, this.salt));
    if (!row) return null;
    Object.assign(row, patch);
    this.flush();
    return this.find(token);
  }

  revokeLead(leadId) {
    let changed = false;
    for (const row of this.rows.values()) {
      if (row.lead_id === leadId && !row.revoked) {
        row.revoked = true;
        changed = true;
      }
    }
    if (changed) this.flush();
  }

  reset() {
    this.rows.clear();
    this.flush();
  }
}

function summarizeAnswers(schema, answers) {
  const lines = [];
  const src = answers || {};
  for (const step of schema?.steps || []) {
    for (const field of step.fields || []) {
      if (field.name === 'persons' || field.name === 'pets') continue;
      const value = src[field.name];
      if (value == null || value === '') continue;
      const option = (field.options || []).find((row) => row.value === value);
      lines.push({ label: field.label, value: option ? option.label : String(value) });
    }
  }
  return lines;
}

module.exports = {
  TIMELINE_OPTIONS,
  flagsFrom,
  formatSummaryLine,
  brokerUrl,
  incomeThresholds,
  formSchema,
  applyFragebogen,
  summarizeAnswers,
  tokenHash,
  FragebogenStore,
  scoreInput,
};
