'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../core/config');

const DISQ_URL = 'https://disq.de/2024/20240221-immobilienmakler.html';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function legalLink(href, label) {
  if (!href) return `<span>${esc(label)}: Angaben fehlen</span>`;
  return `<a href="${esc(href)}">${esc(label)}</a>`;
}

function renderLanding(config) {
  const profile = config.MAKLER_PROFILE || {};
  const product = config.PRODUCT_NAME || 'Erstantwort';
  const demo = config.OFFICE_MODE !== 'live';
  const banner = demo
    ? '<p class="banner">Demo · fiktive Angaben, bis der Betreiber Name und Adresse einträgt.</p>'
    : '';
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(product)} — die erste Antwort für Maklerbüros</title>
  <link rel="stylesheet" href="site.css">
</head>
<body>
  <main>
    ${banner}
    <p class="logo">${esc(product)}</p>
    <h1>Die erste Antwort auf jede Anfrage. Noch am selben Tag.</h1>
    <p class="lead">Erstantwort schreibt den Entwurf. Sie geben ihn frei. Gedacht für ein kleines Maklerbüro, nicht für ein Portal.</p>
    <section class="stat">
      <p>In der Servicestudie Immobilienmakler 2024 des Deutschen Instituts für Service-Qualität blieb fast jede zweite E-Mail-Anfrage unbeantwortet: <strong>47 Prozent</strong>. Geprüft wurden zehn überregionale Makler, nicht der ganze Markt.</p>
      <p><a href="${DISQ_URL}">Servicestudie Immobilienmakler 2024, DISQ</a></p>
    </section>
    <section class="offer">
      <h2>30 Tage Pilot kostenlos</h2>
      <p>Sie sehen Ihre eigenen Anfragen, den Entwurf und den Termin. Kosten erst, wenn der Pilot für Sie passt.</p>
    </section>
    <ol>
      <li>Die Anfrage kommt an. Der Entwurf beginnt mit dem KI-Hinweis und endet mit STOP.</li>
      <li>Sie lesen den Text und geben ihn frei. Ohne Freigabe geht nichts hinaus.</li>
      <li>Antwortet der Interessent mit „Nr. 2“, entsteht der Termin in Ihrem Kalender.</li>
    </ol>
    <form action="#" method="post">
      <label for="email">E-Mail Ihres Büros</label>
      <input id="email" name="email" type="email" autocomplete="off" disabled>
      <button type="button" disabled>Pilot anfragen</button>
      <p class="note">Noch keine Anmeldung. Dieses Formular speichert nichts und sendet nichts.</p>
    </form>
    <footer>
      ${legalLink(profile.impressum_url, 'Impressum')}
      ${legalLink(profile.datenschutz_url, 'Datenschutz')}
    </footer>
  </main>
</body>
</html>
`;
}

function main() {
  const html = renderLanding(loadConfig(process.env));
  const file = path.join(__dirname, 'index.html');
  fs.writeFileSync(file, html);
  console.log(`landing_written ${file}`);
}

if (require.main === module) main();

module.exports = { renderLanding, DISQ_URL };
