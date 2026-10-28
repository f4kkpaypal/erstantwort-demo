'use strict';

const net = require('node:net');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function startMiniSmtp() {
  const messages = [];
  const server = net.createServer((socket) => {
    let buf = '';
    let mode = 'cmd';
    let data = '';
    let auth = 0;
    socket.write('220 local smtp\r\n');
    const takeData = () => {
      const end = data.indexOf('\r\n.\r\n');
      if (end === -1) return;
      messages.push(data.slice(0, end));
      data = data.slice(end + 5);
      mode = 'cmd';
      socket.write('250 OK\r\n');
    };
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (mode === 'data') {
        data += buf;
        buf = '';
        takeData();
        return;
      }
      let nl;
      while (mode === 'cmd' && (nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-local\r\n250 AUTH LOGIN PLAIN\r\n');
        } else if (upper.startsWith('AUTH LOGIN')) {
          auth = 1;
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (upper.startsWith('AUTH')) {
          socket.write('235 OK\r\n');
        } else if (auth === 1) {
          auth = 2;
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (auth === 2) {
          auth = 0;
          socket.write('235 OK\r\n');
        } else if (upper.startsWith('MAIL') || upper.startsWith('RCPT')) {
          socket.write('250 OK\r\n');
        } else if (upper === 'DATA') {
          mode = 'data';
          socket.write('354 GO\r\n');
          data += buf;
          buf = '';
          takeData();
        } else if (upper.startsWith('STARTTLS')) {
          socket.write('454 TLS not available\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 BYE\r\n');
          socket.end();
        } else if (upper === 'RSET' || upper === 'NOOP') {
          socket.write('250 OK\r\n');
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
  });
  return listen(server).then((port) => ({
    port,
    messages,
    close: () => new Promise((resolve) => server.close(resolve)),
  }));
}

function startMiniImap({ user, pass }) {
  const messages = [];
  const server = net.createServer((socket) => {
    let buf = '';
    let authed = false;
    socket.write('* OK local imap\r\n');
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const match = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(line);
        if (!match) continue;
        const tag = match[1];
        const cmd = match[2].toUpperCase();
        const rest = match[3] || '';
        if (cmd === 'CAPABILITY') {
          socket.write('* CAPABILITY IMAP4rev1\r\n');
          socket.write(`${tag} OK CAPABILITY\r\n`);
        } else if (cmd === 'LOGIN') {
          const parts = rest.split(/\s+/);
          const gotUser = (parts[0] || '').replace(/^"|"$/g, '');
          const gotPass = (parts[1] || '').replace(/^"|"$/g, '');
          if (gotUser === user && gotPass === pass) {
            authed = true;
            socket.write(`${tag} OK LOGIN\r\n`);
          } else {
            socket.write(`${tag} NO LOGIN\r\n`);
          }
        } else if (!authed) {
          socket.write(`${tag} NO AUTH\r\n`);
        } else if (cmd === 'SELECT') {
          socket.write(`* ${messages.length} EXISTS\r\n`);
          socket.write('* 0 RECENT\r\n');
          socket.write('* FLAGS (\\Seen)\r\n');
          socket.write(`${tag} OK [READ-WRITE] SELECT\r\n`);
        } else if (cmd === 'SEARCH') {
          const ids = messages.map((row, index) => (row.seen ? null : index + 1)).filter(Boolean);
          socket.write(`* SEARCH${ids.length ? ` ${ids.join(' ')}` : ''}\r\n`);
          socket.write(`${tag} OK SEARCH\r\n`);
        } else if (cmd === 'FETCH') {
          const num = Number(rest.split(/\s+/)[0]);
          const row = messages[num - 1];
          if (!row) {
            socket.write(`${tag} NO FETCH\r\n`);
            continue;
          }
          const raw = row.raw.endsWith('\r\n') ? row.raw : `${row.raw}\r\n`;
          const size = Buffer.byteLength(raw);
          socket.write(`* ${num} FETCH (BODY[] {${size}}\r\n`);
          socket.write(raw);
          socket.write(`)\r\n`);
          socket.write(`${tag} OK FETCH\r\n`);
        } else if (cmd === 'STORE') {
          const num = Number(rest.split(/\s+/)[0]);
          if (messages[num - 1]) messages[num - 1].seen = true;
          socket.write(`${tag} OK STORE\r\n`);
        } else if (cmd === 'LOGOUT') {
          socket.write('* BYE\r\n');
          socket.write(`${tag} OK LOGOUT\r\n`);
          socket.end();
        } else if (cmd === 'NOOP') {
          socket.write(`${tag} OK NOOP\r\n`);
        } else {
          socket.write(`${tag} OK\r\n`);
        }
      }
    });
  });
  return listen(server).then((port) => ({
    port,
    push(raw) {
      messages.push({ raw: String(raw).replace(/\r?\n/g, '\r\n'), seen: false });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }));
}

module.exports = { startMiniSmtp, startMiniImap };
