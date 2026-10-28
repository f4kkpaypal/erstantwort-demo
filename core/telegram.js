'use strict';

const { allowedTelegramIds } = require('./uiAuth');

const CLOSED = 'Dieser Bot ist nicht öffentlich.';

function sheetLine(makler) {
  const url = makler?.sheet_url;
  if (url && /^https:\/\//.test(url)) return `Ihr CRM (Demo): ${url}`;
  return 'Ihr CRM (Demo)';
}

function notifyNewLead({ leadId, grade, score, listingId, makler, attachment, kind }) {
  const who = kind === 'eigentuemer' ? 'Neuer Eigentümer-Lead' : 'Neuer Lead';
  const lines = [
    `${who} ${leadId} · ${grade} (${score}) · Objekt ${listingId || '—'}`,
    sheetLine(makler),
  ];
  if (attachment) lines.push('Anhang im Postfach');
  return lines.join('\n');
}

function notifyFreigabe({ leadId, grade, listingId, kind }) {
  const who = kind === 'eigentuemer' ? 'den Eigentümer' : 'den Interessenten';
  return [
    `Freigabe nötig ${leadId} · ${grade} · Objekt ${listingId || '—'}`,
    `Es wurde nichts an ${who} gesendet. Bitte Freigeben, bevor eine Antwort hinausgeht.`,
  ].join('\n');
}

function notifyBooked({ leadId, listingId, slotIndex }) {
  return `Termin gebucht ${leadId} · Objekt ${listingId || '—'} · Nr. ${slotIndex}`;
}

function notifyStop({ leadId, listingId }) {
  return `STOP ${leadId} · Objekt ${listingId || '—'} · Automatik aus`;
}

function notifyNeedsHuman({ leadId, listingId, reason }) {
  return `Prüfung nötig ${leadId || '—'} · Objekt ${listingId || '—'} · ${reason || 'unklar'}`;
}

function notifySlotBusy({ leadId, listingId }) {
  return `Slot belegt ${leadId} · Objekt ${listingId || '—'} · keine Buchung`;
}

function miniAppUrl(config) {
  const raw = String(config?.UI_PUBLIC_BASE || '').trim();
  if (!raw.startsWith('https://')) return '';
  try {
    const url = new URL(raw);
    if (url.username || url.password) return '';
    const path = url.pathname.replace(/\/$/, '');
    return `${url.origin}${path}`;
  } catch {
    return '';
  }
}

function helpText(config, withButton) {
  const product = String(config?.PRODUCT_NAME || 'Erstantwort').trim() || 'Erstantwort';
  const appDe = withButton
    ? 'Die Taste unten öffnet die Mini App.'
    : 'Die Mini App öffnet sich in diesem Chat, sobald sie angeschlossen ist. Solange kein https-Link hinterlegt ist, bleiben hier nur die Hinweise.';
  const appRu = withButton
    ? 'Кнопка ниже открывает Mini App.'
    : 'Mini App откроется в этом чате после подключения. Пока ссылки с https нет, здесь только уведомления.';
  return [
    `${product} schreibt den ersten Antwortentwurf für Ihr Maklerbüro. Eine Nachricht an den Interessenten geht erst nach Ihrer Freigabe hinaus.`,
    '',
    'Dieser Bot schickt Hinweise zu neuen Anfragen: Einstufung, Freigabe, Termin. Name, E-Mail und Telefon stehen hier nicht.',
    '',
    appDe,
    '',
    `${product} готовит черновик первого ответа для бюро. Письмо уходит только после вашего Freigabe.`,
    '',
    'Бот присылает уведомления о новых заявках: оценка, Freigabe, срок. Имени, почты и телефона в этих сообщениях нет.',
    '',
    appRu,
  ].join('\n');
}

function replyToIncoming(update, config) {
  const message = update?.message;
  if (!message || message.from?.is_bot) return null;
  const chatId = message.chat?.id;
  const userId = message.from?.id;
  if (chatId == null || userId == null) return null;
  if (!allowedTelegramIds(config).has(String(userId))) {
    return { chatId, text: CLOSED };
  }
  const appUrl = miniAppUrl(config);
  const reply = { chatId, text: helpText(config, Boolean(appUrl)) };
  if (appUrl) {
    reply.replyMarkup = {
      inline_keyboard: [[{ text: 'Mini App öffnen', web_app: { url: appUrl } }]],
    };
  }
  return reply;
}

module.exports = {
  notifyNewLead,
  notifyFreigabe,
  notifyBooked,
  notifyStop,
  notifyNeedsHuman,
  notifySlotBusy,
  CLOSED,
  miniAppUrl,
  helpText,
  replyToIncoming,
};
