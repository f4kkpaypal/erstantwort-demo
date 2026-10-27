'use strict';

const AI_FIRST_LINE = 'Hinweis: Diese Antwort wurde mithilfe künstlicher Intelligenz (KI) erstellt.';
const AI_CONFIRM_LINE = 'Hinweis: Diese Nachricht wurde mithilfe künstlicher Intelligenz (KI) erstellt. Bei Rückfragen antworten Sie einfach auf diese E-Mail.';
const STOP_LINE = 'Sie können der weiteren automatischen Bearbeitung Ihrer Anfrage jederzeit widersprechen: Antworten Sie einfach mit „STOP“.';
const ENGLISH_LINE = 'Gerne können Sie uns auch auf Englisch antworten.';
const FRAGEBOGEN_INTRO = 'Optional: Wenn Sie möchten, können Sie hier in etwa einer Minute ein paar Angaben zu Ihrer Anfrage machen. Das ist freiwillig und keine Voraussetzung für einen Termin:';
const OWNER_FORM_INTRO = 'Optional: Wenn Sie möchten, können Sie hier in etwa einer Minute ein paar Angaben zu Ihrer Immobilie machen. Das ist freiwillig und keine Voraussetzung für einen Bewertungstermin:';
const ENGLISH_LINE_RE = /\s*Gerne können Sie uns auch auf Englisch antworten\.?/gi;

const TOPIC_LABELS = {
  stellplatz: 'Stellplatz',
  provision: 'Provision',
  nebenkosten_hausgeld: 'Nebenkosten / Hausgeld',
  energieausweis: 'Energieausweis',
  verfuegbarkeit: 'Verfügbar ab',
  haustiere: 'Haustiere',
  zustand_renovierung: 'Zustand',
  preis_verhandelbar: 'Preis',
  unterlagen_expose: 'Unterlagen',
  sonstiges: 'Sonstiges',
};

const TOPIC_FIELDS = {
  stellplatz: 'stellplatz_text',
  provision: 'provision_text',
  nebenkosten_hausgeld: 'nebenkosten_hausgeld_text',
  energieausweis: 'energieausweis_text',
  verfuegbarkeit: 'verfuegbar_ab_text',
  haustiere: 'haustiere_text',
  zustand_renovierung: 'zustand_text',
};

const FORBIDDEN_RE = [
  /https?:\/\//i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:\+|00)\d[\d\s()./-]{6,}\d/,
  /€|\bEUR\b/i,
  /\d{3,}/,
  /\b(?:noch frei|provisionsfrei|reserviert|zugesagt|garantiert|inklusive|verfügbar)\b/i,
  /Extraktionsmodul/i,
  /Vorgaben:/,
];

function anrede(contact) {
  const last = String(contact?.last_name || '').trim();
  if (contact?.salutation === 'Herr' && last) return `Sehr geehrter Herr ${last}`;
  if (contact?.salutation === 'Frau' && last) return `Sehr geehrte Frau ${last}`;
  return 'Guten Tag';
}

function shortTitle(title) {
  const text = String(title || 'Ihr Objekt').trim();
  if (text.length <= 80) return text;
  return `${text.slice(0, 77).trim()}...`;
}

function factLines(questions, objekt, maklerName) {
  const lines = [];
  const answered = [];
  for (const topic of questions || []) {
    const label = TOPIC_LABELS[topic];
    if (!label) continue;
    const field = TOPIC_FIELDS[topic];
    const raw = field && objekt ? String(objekt[field] || '').trim() : '';
    if (raw) {
      lines.push(`  • ${label}: ${raw}`);
      answered.push(topic);
    } else {
      lines.push(`  • ${label}: beantwortet ${maklerName} persönlich`);
    }
  }
  return { lines, answered };
}

function paragraphsOk(paragraphs) {
  if (!Array.isArray(paragraphs) || paragraphs.length < 1 || paragraphs.length > 3) return false;
  return paragraphs.every((p) => {
    const text = String(p || '').trim();
    if (!text || text.length > 450) return false;
    return !FORBIDDEN_RE.some((re) => re.test(text));
  });
}

const ATTRIBUTE_RULES = [
  {
    topic: 'stellplatz',
    mention: /stellpl|tiefgarage|parkplatz|\bgarage\b/i,
    conflicts(fact, paragraph) {
      if (/separat/i.test(fact) && /verbunden|inklusive|inbegriffen|geh(?:ö|oe)rt zur wohnung|direkt mit der wohnung|im preis enthalten|mitvermietet/i.test(paragraph)) {
        return true;
      }
      if (/nicht vorhanden|kein(?:en)? stellplatz|ohne stellplatz/i.test(fact) && /vorhanden|inklusive|separat/i.test(paragraph)) {
        return true;
      }
      return false;
    },
  },
  {
    topic: 'provision',
    mention: /provision/i,
    conflicts(fact, paragraph) {
      const free = /keine provision|f(?:ä|ae)llt keine|provisionsfrei/i.test(fact);
      const factFee = /prozent|betr(?:ä|ae)gt|k(?:ä|ae)uferprovision|vermieterprovision/i.test(fact);
      if (free && /betr(?:ä|ae)gt|prozent|f(?:ä|ae)llig|k(?:ä|ae)uferprovision|vermieterprovision|zuz(?:ü|ue)glich/i.test(paragraph)) {
        return true;
      }
      if (factFee && /provisionsfrei|keine provision|f(?:ä|ae)llt keine/i.test(paragraph)) return true;
      return false;
    },
  },
  {
    topic: 'haustiere',
    mention: /haustier/i,
    conflicts(fact, paragraph) {
      if (/nicht erlaubt|keine haustiere|verboten/i.test(fact) && /erlaubt|gestattet|willkommen|m(?:ö|oe)glich/i.test(paragraph)) {
        return true;
      }
      if (/erlaubt|m(?:ö|oe)glich|gestattet/i.test(fact) && /nicht erlaubt|verboten|keine haustiere/i.test(paragraph)) {
        return true;
      }
      return false;
    },
  },
];

function isPointer(paragraph) {
  return /unten|folgt|folgen|pers(?:ö|oe)nlich/i.test(paragraph)
    && !/verbunden|inklusive|vorhanden|separat|betr(?:ä|ae)gt|provisionsfrei|nicht erlaubt/i.test(paragraph);
}

function paragraphsConsistent(paragraphs, objekt) {
  if (!Array.isArray(paragraphs)) return false;
  for (const paragraph of paragraphs) {
    for (const rule of ATTRIBUTE_RULES) {
      if (!rule.mention.test(paragraph)) continue;
      const field = TOPIC_FIELDS[rule.topic];
      const fact = field && objekt ? String(objekt[field] || '').trim() : '';
      if (!fact) {
        if (!isPointer(paragraph)) return false;
        continue;
      }
      if (rule.conflicts(fact, paragraph)) return false;
    }
  }
  return true;
}

function stripEnglishLine(paragraphs) {
  return (paragraphs || [])
    .map((p) => String(p).replace(ENGLISH_LINE_RE, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean);
}

function applyEnglishLine(paragraphs, offerEnglish) {
  const copy = (offerEnglish ? paragraphs : stripEnglishLine(paragraphs)).map((p) => String(p).trim()).filter(Boolean);
  if (!copy.length) return ['Vielen Dank für Ihr Interesse an der Immobilie.'];
  if (offerEnglish && !copy[copy.length - 1].includes(ENGLISH_LINE)) {
    copy[copy.length - 1] = `${copy[copy.length - 1]} ${ENGLISH_LINE}`.trim();
  }
  return copy.slice(0, 3);
}

function fallbackParagraphs({ questionsToAsk, slotsCount, offerEnglish }) {
  const paras = ['Vielen Dank für Ihr Interesse an der Immobilie.'];
  const asks = [];
  if ((questionsToAsk || []).includes('budget')) asks.push('Ihr Budget');
  if ((questionsToAsk || []).includes('financing')) asks.push('Ihren Finanzierungsstand');
  if ((questionsToAsk || []).includes('timeline')) asks.push('den gewünschten Zeitraum');
  if (asks.length) {
    paras.push(`Bitte teilen Sie uns noch ${asks.join(' und ')} mit.`);
  }
  if (slotsCount > 0) paras.push('Unten folgen Terminvorschläge für eine Besichtigung.');
  return applyEnglishLine(paras, offerEnglish === true);
}

function signature(makler) {
  return [
    'Mit freundlichen Grüßen',
    `${makler.name} · ${makler.buero} · ${makler.adresse} · ${makler.telefon}`,
    `Impressum: ${makler.impressum_url} · Datenschutzhinweise: ${makler.datenschutz_url}`,
    STOP_LINE,
  ].join('\n');
}

function slotBlock(slots, objekt) {
  const mode = objekt?.booking_mode || 'individual';
  if (mode === 'off') return 'Wir melden uns mit Terminvorschlägen.';
  if (mode === 'group') {
    const text = String(objekt.group_slots || '').trim();
    return text || 'Wir melden uns mit Terminvorschlägen.';
  }
  if (!slots || slots.length === 0) return 'Wir melden uns mit Terminvorschlägen.';
  const lines = slots.map((slot, i) => `  ${i + 1}) ${slot.label}`);
  return [
    'Mögliche Besichtigungstermine:',
    ...lines,
    'Bitte antworten Sie mit der Nummer des passenden Termins oder schlagen Sie eine Alternative vor.',
    'Die Termine sind noch nicht reserviert.',
  ].join('\n');
}

function composeFirstReply({ lead, objekt, slots, paragraphs, makler, leadId, usedFallback, offerEnglish, fragebogenUrl }) {
  const contact = lead.contact || {};
  const title = lead.listing?.title || objekt?.title || 'Ihr Objekt';
  const listingId = lead.listing?.portal_listing_id || objekt?.portal_listing_id || '';
  const questions = lead.questions || [];
  const facts = factLines(questions, objekt, makler.name);
  const offer = offerEnglish != null ? offerEnglish === true : lead.language === 'en';
  const consistent = paragraphsConsistent(paragraphs, objekt);
  const bodyParagraphs = (usedFallback || !paragraphsOk(paragraphs) || !consistent)
    ? fallbackParagraphs({
      questionsToAsk: lead.questions_to_ask || [],
      slotsCount: (objekt?.booking_mode === 'off' || objekt?.booking_mode === 'group') ? 0 : (slots || []).length,
      offerEnglish: offer,
    })
    : applyEnglishLine(paragraphs, offer);

  const blocks = [
    AI_FIRST_LINE,
    `Bei Rückfragen antworten Sie einfach auf diese E-Mail – ${makler.name} meldet sich persönlich.`,
    '',
    `${anrede(contact)},`,
    '',
    bodyParagraphs.join('\n\n'),
  ];
  if (facts.lines.length) {
    blocks.push('', 'Zu Ihren Fragen:', ...facts.lines);
  }
  blocks.push('', slotBlock(slots, objekt));
  if (fragebogenUrl) blocks.push('', `${FRAGEBOGEN_INTRO} ${fragebogenUrl}`);
  blocks.push('', signature(makler));
  const text = blocks.join('\n');
  const subject = `Ihre Anfrage: ${shortTitle(title)} (ImmoScout24-ID ${listingId}) [${leadId}]`;
  return {
    subject,
    text,
    used_fallback: usedFallback || !paragraphsOk(paragraphs) || !consistent,
    answered_topics: facts.answered,
    anrede: anrede(contact),
  };
}

function ownerFactLines(owner) {
  const lines = [];
  const typeLabel = {
    wohnung: 'Wohnung',
    haus: 'Haus',
    grundstueck: 'Grundstück',
    gewerbe: 'Gewerbe',
  }[owner?.object_type] || '';
  if (typeLabel) lines.push(`  • Art: ${typeLabel}`);
  const place = [owner?.district, owner?.city].filter(Boolean).join(', ');
  if (place) lines.push(`  • Lage: ${place}`);
  if (owner?.area_sqm) lines.push(`  • Fläche, Ihre Angabe: ca. ${owner.area_sqm} m²`);
  return lines;
}

function composeOwnerReply({ lead, slots, makler, leadId, fragebogenUrl }) {
  const contact = lead.contact || {};
  const title = lead.listing?.title || 'Ihre Immobilie';
  const prose = ['vielen Dank für Ihre Nachricht. Gern schauen wir uns Ihre Immobilie vor Ort an und besprechen einen möglichen Verkauf.'];
  const body = paragraphsOk(prose) && paragraphsConsistent(prose, null)
    ? prose
    : ['vielen Dank für Ihre Nachricht. Gern vereinbaren wir einen Termin zur Bewertung vor Ort.'];
  const facts = ownerFactLines(lead.owner);
  const blocks = [
    AI_FIRST_LINE,
    `Bei Rückfragen antworten Sie einfach auf diese E-Mail – ${makler.name} meldet sich persönlich.`,
    '',
    `${anrede(contact)},`,
    '',
    body.join('\n\n'),
  ];
  if (facts.length) blocks.push('', 'Zu Ihrem Objekt (Ihre Angaben):', ...facts);
  blocks.push('', ownerSlotBlock(slots));
  if (fragebogenUrl) blocks.push('', `${OWNER_FORM_INTRO} ${fragebogenUrl}`);
  blocks.push('', signature(makler));
  return {
    subject: `Ihre Verkaufsanfrage: ${shortTitle(title)} [${leadId}]`,
    text: blocks.join('\n'),
    used_fallback: false,
    answered_topics: [],
    anrede: anrede(contact),
  };
}

function ownerSlotBlock(slots) {
  if (!slots || slots.length === 0) return 'Wir melden uns mit Terminvorschlägen für eine Vor-Ort-Bewertung.';
  const lines = slots.map((slot, i) => `  ${i + 1}) ${slot.label}`);
  return [
    'Mögliche Termine für eine Vor-Ort-Bewertung:',
    ...lines,
    'Bitte antworten Sie mit der Nummer des passenden Termins oder schlagen Sie eine Alternative vor.',
    'Die Termine sind noch nicht reserviert.',
  ].join('\n');
}

function composeOwnerConfirmation({ lead, slot, makler, leadId }) {
  const title = lead.listing?.title || 'Ihre Immobilie';
  const when = slot.label_long || slot.label;
  const text = [
    AI_CONFIRM_LINE,
    '',
    `${anrede(lead.contact)},`,
    `vielen Dank – wir bestätigen Ihren Bewertungstermin vor Ort: ${when}.`,
    'Falls Sie verhindert sind, antworten Sie bitte mit „ABSAGE“.',
    '',
    'Mit freundlichen Grüßen',
    `${makler.name} · ${makler.buero} · ${makler.adresse} · ${makler.telefon}`,
    `Impressum: ${makler.impressum_url} · Datenschutzhinweise: ${makler.datenschutz_url}`,
    STOP_LINE,
  ].join('\n');
  return {
    subject: `Bestätigung Bewertungstermin: ${shortTitle(title)} [${leadId}]`,
    text,
  };
}

function composeConfirmation({ lead, objekt, slot, makler, leadId }) {
  const title = lead.listing?.title || objekt?.title || 'Ihr Objekt';
  const where = (objekt?.viewing_location || '').trim() || 'den vereinbarten Treffpunkt';
  const when = slot.label_long || slot.label;
  const text = [
    AI_CONFIRM_LINE,
    '',
    `${anrede(lead.contact)},`,
    `vielen Dank – wir bestätigen Ihren Besichtigungstermin: ${when}, Treffpunkt: ${where}.`,
    'Falls Sie verhindert sind, antworten Sie bitte mit „ABSAGE“.',
    '',
    'Mit freundlichen Grüßen',
    `${makler.name} · ${makler.buero} · ${makler.adresse} · ${makler.telefon}`,
    `Impressum: ${makler.impressum_url} · Datenschutzhinweise: ${makler.datenschutz_url}`,
    STOP_LINE,
  ].join('\n');
  return {
    subject: `Bestätigung Besichtigung: ${shortTitle(title)} [${leadId}]`,
    text,
  };
}

function decideSend({ kind, config, optout }) {
  if (optout) return { ok: false, reason: 'optout' };
  if (kind === 'followup') {
    if (!config.FOLLOWUP_EMAIL_ENABLED) return { ok: false, reason: 'followup_disabled' };
    return { ok: false, reason: 'followup_not_in_loom_slice' };
  }
  if (kind === 'reoffer') {
    if (!config.NOSHOW_REOFFER_ENABLED) return { ok: false, reason: 'reoffer_disabled' };
    return { ok: false, reason: 'reoffer_not_in_loom_slice' };
  }
  if (kind === 'interesse_weiterhin') {
    if (!config.INTERESSE_FOLLOWUP_ENABLED) return { ok: false, reason: 'interesse_disabled' };
    return { ok: false, reason: 'interesse_not_in_loom_slice' };
  }
  if (config.SEND_MODE !== 'auto' && kind !== 'confirmation') {
    return {
      ok: false,
      reason: 'awaiting_freigabe',
      approval_timeout_action: config.APPROVAL_TIMEOUT_ACTION,
    };
  }
  return { ok: true, reason: 'auto' };
}

function recipientAllowed({ leadEmail, proposedTo, relayDomains }) {
  const lead = String(leadEmail || '').trim().toLowerCase();
  const to = String(proposedTo || '').trim().toLowerCase();
  if (!lead || !EMAIL_SIMPLE(to) || to !== lead) return false;
  const domain = to.split('@')[1] || '';
  const relays = relayDomains || [];
  if (relays.length === 0) return true;
  return relays.includes(domain) || domain === lead.split('@')[1];
}

function EMAIL_SIMPLE(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

module.exports = {
  AI_FIRST_LINE,
  AI_CONFIRM_LINE,
  STOP_LINE,
  TOPIC_LABELS,
  anrede,
  ENGLISH_LINE,
  FRAGEBOGEN_INTRO,
  OWNER_FORM_INTRO,
  paragraphsOk,
  paragraphsConsistent,
  stripEnglishLine,
  fallbackParagraphs,
  composeFirstReply,
  composeOwnerReply,
  composeOwnerConfirmation,
  composeConfirmation,
  decideSend,
  recipientAllowed,
  factLines,
  shortTitle,
};
