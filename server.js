// 8-Ball Pool – egen server. Inga beroenden: kör bara `node server.js`.
// Serverar spelet och skickar vidare meddelanden mellan spelarna i samma rum (WebSocket).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.PASSWORD || '';   // valfritt: sätt PASSWORD för att kräva lösenord
const PUB = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname; // fungerar med index.html i public/ eller bredvid server.js
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };


/* ---- konton: användarnamn + lösenord, molnsparning ---- */
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA, { recursive: true }); } catch (_) { }
const UF = path.join(DATA, 'users.json'), SF = path.join(DATA, 'secret');
let users = {}; try { users = JSON.parse(fs.readFileSync(UF, 'utf8')); } catch (_) { }
const SECRET = process.env.SECRET || (() => { try { return fs.readFileSync(SF, 'utf8'); } catch (_) { const s = crypto.randomBytes(32).toString('hex'); try { fs.writeFileSync(SF, s); } catch (_) { } return s; } })();
let dirty = false;
function persist() {
  if (dirty) return; dirty = true;
  setTimeout(() => { dirty = false; try { const t = UF + '.tmp'; fs.writeFileSync(t, JSON.stringify(users)); fs.renameSync(t, UF); } catch (e) { console.error('kunde inte spara konton:', e.message); } }, 1500);
}
const hmac = body => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
function mkToken(name) { const body = Buffer.from(name).toString('base64url') + '.' + (Date.now() + 90 * 864e5); return body + '.' + hmac(body); }
function verToken(t) {
  if (typeof t !== 'string') return null; const p = t.split('.'); if (p.length !== 3) return null;
  const a = Buffer.from(hmac(p[0] + '.' + p[1])), b = Buffer.from(p[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b) || +p[1] < Date.now()) return null;
  return users[Buffer.from(p[0], 'base64url').toString().toLowerCase()] || null;
}
const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 32, (e, k) => e ? no(e) : ok(k.toString('hex'))));
const NAME_RE = /^[\p{L}\p{N}_-]{3,16}$/u, hits = new Map();
function limited(ip) {
  const now = Date.now(), h = hits.get(ip) || { n: 0, t: now };
  if (now - h.t > 600000) { h.n = 0; h.t = now; }
  h.n++; hits.set(ip, h); return h.n > 25;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.t > 600000) hits.delete(k); }, 600000);
function clean(d) {
  const o = {}; let n = 0;
  if (!d || typeof d !== 'object') return o;
  for (const k of Object.keys(d)) {
    if (++n > 300) break;
    if (k.length > 80 || !k.startsWith('pool8.') || k.startsWith('pool8.mt.') || k === 'pool8.acct') continue;
    if (typeof d[k] === 'string' && d[k].length <= 30000) o[k] = d[k];
  }
  return o;
}
function readBody(req, cb) {
  let n = 0; const ch = [];
  req.on('data', d => { n += d.length; if (n > 600000) { req.destroy(); return; } ch.push(d); });
  req.on('end', () => { try { cb(JSON.parse(Buffer.concat(ch).toString('utf8'))); } catch (_) { cb(null); } });
}
function json(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); }
function board(me) {
  const rows = Object.values(users).map(u => {
    const d = u.data || {}; let stars = 0, st = {}, tr = {};
    for (const k in d) if (k.startsWith('pool8.chal.')) stars += parseInt(d[k], 10) || 0;
    try { st = JSON.parse(d['pool8.stats'] || '{}') || {}; } catch (_) { }
    try { tr = JSON.parse(d['pool8.trophies'] || '{}') || {}; } catch (_) { }
    const bi = k => { const v = parseInt(d[k], 10); return isNaN(v) ? 0 : v; };
    return { name: u.name, trophies: Object.keys(tr).length, stars, won: st.mpWon | 0, streak: st.bestStreak | 0, pots: st.pots | 0, clear: bi('pool8.best.clear'), nine: bi('pool8.best.nine') };
  });
  const LOW = { clear: 1, nine: 1 }, cats = {}, ml = String(me || '').toLowerCase();
  for (const key of ['trophies', 'stars', 'won', 'streak', 'clear', 'nine', 'pots']) {
    const list = rows.filter(r => r[key] > 0).sort((a, b) => (LOW[key] ? a[key] - b[key] : b[key] - a[key]) || a.name.localeCompare(b.name));
    const idx = ml ? list.findIndex(r => r.name.toLowerCase() === ml) : -1;
    cats[key] = { top: list.slice(0, 10).map(r => ({ name: r.name, v: r[key] })), me: idx >= 0 ? { rank: idx + 1, v: list[idx][key] } : null, n: list.length };
  }
  return { cats };
}
function api(req, res, p) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.method === 'GET') { if (p === '/api/ping') return json(res, 200, { ok: 1 }); if (p === '/api/board') return json(res, 200, board(new URL(req.url, 'http://x').searchParams.get('me'))); return json(res, 404, { err: 'nf' }); }
  if (req.method !== 'POST') return json(res, 405, { err: 'method' });
  readBody(req, async m => {
    try {
      if (!m || typeof m !== 'object') return json(res, 400, { err: 'bad' });
      if (p === '/api/register' || p === '/api/login') {
        if (limited(ip)) return json(res, 429, { err: 'rate' });
        const name = String(m.name || '').trim(), pw = String(m.pw || '');
        if (!NAME_RE.test(name)) return json(res, 400, { err: 'bad_name' });
        if (pw.length < 6 || pw.length > 64) return json(res, 400, { err: 'bad_pw' });
        const key = name.toLowerCase(); let u = users[key];
        if (p === '/api/register') {
          if (u) return json(res, 409, { err: 'taken' });
          if (Object.keys(users).length >= 5000) return json(res, 503, { err: 'full' });
          const salt = crypto.randomBytes(16).toString('hex');
          u = users[key] = { name, salt, hash: await scrypt(pw, salt), created: Date.now(), data: {}, upd: 0 }; persist();
        } else {
          const h = u ? await scrypt(pw, u.salt) : null;
          if (!u || h.length !== u.hash.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.hash))) return json(res, 401, { err: 'bad_login' });
        }
        return json(res, 200, { token: mkToken(u.name), name: u.name, data: u.data, upd: u.upd });
      }
      const u = verToken(m.token);
      if (!u) return json(res, 401, { err: 'auth' });
      if (p === '/api/me') return json(res, 200, { name: u.name, data: u.data, upd: u.upd });
      if (p === '/api/save') { u.data = clean(m.data); u.upd = Date.now(); persist(); return json(res, 200, { ok: 1, upd: u.upd }); }
      return json(res, 404, { err: 'nf' });
    } catch (e) { console.error(e); json(res, 500, { err: 'server' }); }
  });
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  if (p.startsWith('/api/')) return api(req, res, p);
  if (p === '/health') { res.writeHead(200); return res.end('ok'); }
  if (p === '/auth') { const ok = !PASSWORD || new URL(req.url, 'http://x').searchParams.get('pw') === PASSWORD; res.writeHead(ok ? 200 : 401); return res.end(ok ? 'ok' : 'no'); }
  if (p !== '/index.html') { res.writeHead(404); return res.end('Not found'); }
  const f = path.join(PUB, 'index.html');
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(d);
  });
});

/* ---- minimal WebSocket (RFC 6455), text frames ---- */
const clients = new Set();           // { socket, buf, rooms:Map<room,peerId>, alive }
const rooms = new Map();             // room -> Set<client>
const MAXMSG = 64 * 1024, MAXROOM = 8;

function frame(str, op = 1) {
  const b = Buffer.from(str), n = b.length;
  let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, b]);
}
function send(c, str) { if (!c.socket.destroyed) c.socket.write(frame(str)); }

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  if (PASSWORD && new URL(req.url, 'http://x').searchParams.get('pw') !== PASSWORD) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = { socket, buf: Buffer.alloc(0), rooms: new Map(), alive: true, frag: null };
  clients.add(c);
  socket.on('data', d => { c.buf = Buffer.concat([c.buf, d]); if (c.buf.length > MAXMSG * 2) return drop(c); parse(c); });
  socket.on('close', () => drop(c));
  socket.on('error', () => drop(c));
});

function parse(c) {
  for (;;) {
    const b = c.buf; if (b.length < 2) return;
    const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > MAXMSG) return drop(c);
    if (!masked) return drop(c);
    if (b.length < off + 4 + len) return;
    const mask = b.slice(off, off + 4), data = Buffer.from(b.slice(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
    c.buf = b.slice(off + 4 + len);
    if (op === 8) { try { c.socket.write(frame('', 8)); } catch (_) { } return drop(c); }
    if (op === 9) { c.socket.write(frame(data.toString(), 10)); continue; }
    if (op === 10) { c.alive = true; continue; }
    if (op === 1 || op === 0) {
      c.frag = op === 1 ? [data] : (c.frag || []).concat([data]);
      if (fin) { const s = Buffer.concat(c.frag).toString('utf8'); c.frag = null; onMessage(c, s); }
    }
  }
}

function onMessage(c, s) {
  let m; try { m = JSON.parse(s); } catch (_) { return; }
  if (!m || typeof m.room !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(m.room) || typeof m.from !== 'string' || m.from.length > 32) return;
  let set = rooms.get(m.room);
  if (!c.rooms.has(m.room)) {
    if (c.rooms.size >= MAXROOM) return;
    if (!set) rooms.set(m.room, set = new Set());
    set.add(c); c.rooms.set(m.room, m.from);
  }
  if (m.t === 'bye') { leave(c, m.room, false); }
  for (const o of set || []) if (o !== c) send(o, s);
}
function leave(c, room, notify = true) {
  const from = c.rooms.get(room); if (from === undefined) return;
  c.rooms.delete(room);
  const set = rooms.get(room);
  if (set) { set.delete(c); if (!set.size) rooms.delete(room); else if (notify) for (const o of set) send(o, JSON.stringify({ t: 'bye', room, from })); }
}
function drop(c) {
  if (!clients.has(c)) return;
  clients.delete(c);
  for (const room of [...c.rooms.keys()]) leave(c, room, true);
  try { c.socket.destroy(); } catch (_) { }
}
setInterval(() => { for (const c of clients) { if (!c.alive) { drop(c); continue; } c.alive = false; try { c.socket.write(frame('', 9)); } catch (_) { } } }, 30000);

server.listen(PORT, () => {
  const nets = require('os').networkInterfaces(), ips = [];
  for (const k in nets) for (const n of nets[k]) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  console.log('8-Ball Pool körs på:\n  http://localhost:' + PORT + (ips.length ? '\n' + ips.map(i => '  http://' + i + ':' + PORT + '  (samma wifi)').join('\n') : ''));
});
