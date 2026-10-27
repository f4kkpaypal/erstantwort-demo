'use strict';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <main class="shell">
    ${body}
  </main>
</body>
</html>`;
}

const PLACEHOLDER_NOTE = 'Platzhalter — vor Nutzung durch Anwalt prüfen';

function placeholder() {
  return `<p class="banner">${esc(PLACEHOLDER_NOTE)}</p>`;
}

function missing(product) {
  return `${placeholder()}<article class="card">
      <div class="logo">${esc(product)}</div>
      <h1>Angaben fehlen</h1>
      <p>Für den Betrieb sind Name, Adresse und E-Mail des Betreibers noch nicht eingetragen. Diese Seite zeigt keine erfundenen Bürodaten.</p>
      <p>${esc(PLACEHOLDER_NOTE)}. Dies ist kein fertiger Rechtstext.</p>
    </article>`;
}

function renderImpressum(config) {
  const product = config.PRODUCT_NAME || 'Erstantwort';
  const makler = config.MAKLER_PROFILE || {};
  const live = config.OFFICE_MODE === 'live';
  if (live && (!makler.name || !makler.adresse)) {
    return page(`Impressum · ${product}`, missing(product));
  }
  const banner = live ? '' : '<p class="banner">Demo · fiktive Daten</p>';
  const note = live
    ? `<p>${esc(PLACEHOLDER_NOTE)}. Dies ist kein fertiger Rechtstext.</p>`
    : '<p>Diese Angaben sind erfunden und gelten nur für die lokale Demo. Ein echtes Büro trägt hier seine eigenen Daten ein.</p>';
  return page(`Impressum · ${product}`, `${placeholder()}${banner}
    <article class="card">
      <div class="logo">${esc(product)}</div>
      <h1>Impressum</h1>
      <p>${esc(makler.buero || makler.name)}</p>
      <p>${esc(makler.name)}<br>${esc(makler.adresse).replace(/, /g, '<br>')}</p>
      ${makler.telefon ? `<p>Telefon: ${esc(makler.telefon)}</p>` : ''}
      ${makler.email ? `<p>E-Mail: ${esc(makler.email)}</p>` : ''}
      ${note}
    </article>`);
}

function renderDatenschutz(config) {
  const product = config.PRODUCT_NAME || 'Erstantwort';
  const makler = config.MAKLER_PROFILE || {};
  const live = config.OFFICE_MODE === 'live';
  const days = config.RETENTION_DAYS_LEAD || 180;
  if (live && (!makler.name || !makler.adresse)) {
    return page(`Datenschutz · ${product}`, missing(product));
  }
  const banner = live ? '' : '<p class="banner">Demo · fiktive Daten</p>';
  const model = config.LLM_MODE === 'live'
    ? 'Ist ein Sprachmodell eingeschaltet, verarbeitet der in der Auftragsverarbeitung genannte Anbieter den Text der Anfrage. Wo das geschieht, steht nicht in dieser Software.'
    : 'In der Grundeinstellung verlässt der Anfragetext diesen Server nicht, weil kein externes Sprachmodell eingeschaltet ist.';
  return page(`Datenschutz · ${product}`, `${placeholder()}${banner}
    <article class="card">
      <div class="logo">${esc(product)}</div>
      <h1>Datenschutzhinweise</h1>
      <p>${esc(PLACEHOLDER_NOTE)}. Dies ist kein fertiger Rechtstext.</p>
      <p>Verantwortlich ist ${esc(makler.buero || makler.name)}, ${esc(makler.adresse)}.${live ? '' : ' Diese Seite ist eine lokale Demo-Fassung. Sie ersetzt keine Hinweise eines echten Maklerbüros.'}</p>
      <p>Wir verarbeiten Angaben aus einer Anfrage, um sie zu bearbeiten und für das Büro zu priorisieren (Art. 6 Abs. 1 lit. b und f DSGVO). Die Einordnung folgt festen Regeln. Eine automatische Absage gibt es nicht. Antworten können mit Hilfe künstlicher Intelligenz entworfen sein. Solche Nachrichten sind gekennzeichnet.</p>
      <p>Alle Angaben im Fragebogen sind freiwillig. Haushaltszusammensetzung und Haustiere speichern wir nicht. Ein genaues Einkommen speichern wir nur, wenn das Büro dieses Feld eingeschaltet hat, und dann nur als Einordnung, nicht als Ausweis.</p>
      <p>Anfragen werden nach ${esc(days)} Tagen gelöscht. Ein Widerspruch mit „STOP“ bleibt länger gespeichert, damit keine neue automatische Nachricht an dieselbe Adresse geht. Gespeichert wird dafür ein Prüfwert, nicht die Adresse im Klartext.</p>
      <p>${esc(model)} Google Sheet und Google Calendar werden nur genutzt, wenn das Büro sie einschaltet. Die Tabelle erhält E-Mail und Telefon nur, wenn das ausdrücklich eingeschaltet ist.</p>
      <p>Widerspruch: antworten Sie mit „STOP“ auf die E-Mail des Büros.</p>
    </article>`);
}

module.exports = { renderImpressum, renderDatenschutz, PLACEHOLDER_NOTE };
