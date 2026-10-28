'use strict';

const net = require('node:net');
const tls = require('node:tls');
const { parseEml } = require('../core/eml');
const { requestContext } = require('./adapters');
const { runInbound } = require('../core/pipeline');

function quote(value) {
  const text = String(value || '');
  if (/^[\w.@+-]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

class ImapSession {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.lines = [];
    this.waiters = [];
    this.failed = null;
    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    socket.on('error', (err) => {
      this.failed = err;
      this.wake();
    });
    socket.on('end', () => this.wake());
  }

  drain() {
    while (this.buf.length) {
      const text = this.buf.toString('utf8');
      const nl = text.indexOf('\r\n');
      if (nl === -1) return;
      const line = text.slice(0, nl);
      const lit = /\{(\d+)\}$/.exec(line);
      if (lit) {
        const start = Buffer.byteLength(`${line}\r\n`);
        const need = Number(lit[1]);
        if (this.buf.length < start + need) return;
        const bytes = this.buf.subarray(start, start + need);
        this.buf = this.buf.subarray(start + need);
        this.lines.push({ line, literal: bytes.toString('utf8') });
        this.wake();
        continue;
      }
      this.buf = this.buf.subarray(Buffer.byteLength(`${line}\r\n`));
      this.lines.push({ line, literal: '' });
      this.wake();
    }
  }

  wake() {
    const waiter = this.waiters.shift();
    if (waiter) waiter();
  }

  nextLine() {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.failed) return Promise.reject(Object.assign(new Error('imap_closed'), { code: 'imap_closed' }));
    return new Promise((resolve, reject) => {
      this.waiters.push(() => {
        if (this.lines.length) resolve(this.lines.shift());
        else reject(Object.assign(new Error('imap_closed'), { code: 'imap_closed' }));
      });
    });
  }

  async readUntil(tag) {
    const rows = [];
    for (;;) {
      const row = await this.nextLine();
      rows.push(row);
      if (row.line.startsWith(`${tag} `)) return rows;
    }
  }

  async command(tag, parts) {
    this.socket.write(`${tag} ${parts.join(' ')}\r\n`);
    return this.readUntil(tag);
  }

  async greeting() {
    const row = await this.nextLine();
    if (!row || !/^\* OK/i.test(row.line)) {
      throw Object.assign(new Error('imap_greeting'), { code: 'imap_greeting' });
    }
  }
}

function connectImap(config) {
  return new Promise((resolve, reject) => {
    const host = config.IMAP_HOST;
    const port = config.IMAP_PORT;
    const socket = config.IMAP_SECURE
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
      : net.connect({ host, port });
    const session = new ImapSession(socket);
    const fail = () => reject(Object.assign(new Error('imap_connect'), { code: 'imap_connect' }));
    socket.once('error', fail);
    socket.once(config.IMAP_SECURE ? 'secureConnect' : 'connect', () => {
      socket.removeListener('error', fail);
      resolve(session);
    });
  });
}

async function fetchUnseen(config) {
  const session = await connectImap(config);
  try {
    await session.greeting();
    const login = await session.command('a1', ['LOGIN', quote(config.IMAP_USER), quote(config.IMAP_PASSWORD)]);
    if (!/a1 OK/i.test(login.at(-1).line)) {
      throw Object.assign(new Error('imap_login_failed'), { code: 'imap_login_failed' });
    }
    const folder = config.IMAP_FOLDER || 'INBOX';
    const selected = await session.command('a2', ['SELECT', quote(folder)]);
    if (!/a2 OK/i.test(selected.at(-1).line)) {
      throw Object.assign(new Error('imap_select_failed'), { code: 'imap_select_failed' });
    }
    const search = await session.command('a3', ['SEARCH', 'UNSEEN']);
    const star = search.find((row) => row.line.toUpperCase().startsWith('* SEARCH'));
    const ids = String(star?.line || '').split(/\s+/).slice(2).filter((id) => /^\d+$/.test(id));
    const raws = [];
    let n = 10;
    for (const id of ids) {
      const fetched = await session.command(`a${n}`, ['FETCH', id, 'BODY.PEEK[]']);
      n += 1;
      const literal = fetched.map((row) => row.literal).find(Boolean);
      if (literal) raws.push(literal);
      await session.command(`a${n}`, ['STORE', id, '+FLAGS', '(\\Seen)']);
      n += 1;
    }
    await session.command('a9', ['LOGOUT']).catch(() => {});
    return raws;
  } finally {
    session.socket.end();
  }
}

async function pollOnce(deps) {
  if (deps.config.IMAP_MODE !== 'imap') return { skipped: true, count: 0 };
  const raws = await fetchUnseen(deps.config);
  let count = 0;
  for (const raw of raws) {
    const mail = parseEml(raw);
    await requestContext.run({ fixture: mail.fixture || '' }, () => runInbound(mail, deps));
    count += 1;
  }
  deps.imapLastOk = new Date().toISOString();
  deps.imapLastError = '';
  return { count };
}

module.exports = { fetchUnseen, pollOnce, quote };
