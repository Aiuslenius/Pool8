// Poolers – egen server. Inga beroenden: kör bara `node server.js`.
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

/* ---- krediter och butik (servern avgör saldo och köp) ---- */
const TABLE_IDS = ['classic', 'tournament', 'burgundy', 'midnight', 'nordic', 'argyle', 'striped', 'checkered', 'custom', 'galaxy', 'carbon', 'cyber', 'casino', 'camo', 'ocean', 'tartan', 'marble'];
const TABLE_500 = ['galaxy', 'carbon', 'cyber', 'casino', 'camo', 'ocean', 'tartan', 'marble'];
const CUE_IDS = ['classic', 'midnight', 'maple', 'crimson', 'charcoal', 'neon', 'ivory', 'violet', 'custom'];
const WIN_CREDITS = 100, MIN_WIN_GAP = 40000, MAX_WINS_DAY = 40;
function price(item) {
  const m = /^([TC]):([a-z]+)$/.exec(String(item || '')); if (!m) return null;
  if (m[1] === 'T') return TABLE_IDS.includes(m[2]) ? (m[2] === 'classic' ? 0 : TABLE_500.includes(m[2]) ? 500 : 1000) : null;
  return CUE_IDS.includes(m[2]) ? (m[2] === 'classic' ? 0 : 5000) : null;
}
const eco = u => ({ credits: u.credits | 0, owned: Object.keys(u.owned || {}) });
const pend = new Map(), done = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of pend) if (now - v.t > 900000) pend.delete(k); for (const [k, t] of done) if (now - t > 86400000) done.delete(k); }, 300000);
// en vinst räknas först när både vinnaren (w) och förloraren (l), två olika konton, rapporterat samma match
function report(u, mid, res) {
  if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(mid) || (res !== 'w' && res !== 'l') || done.has(mid)) return false;
  let p = pend.get(mid); if (!p) pend.set(mid, p = { t: Date.now(), w: null, l: null });
  p[res] = u.name.toLowerCase();
  if (!p.w || !p.l || p.w === p.l) return false;
  pend.delete(mid); done.set(mid, Date.now());
  const winner = users[p.w]; if (!winner) return false;
  const day = new Date().toISOString().slice(0, 10), now = Date.now();
  if (!winner.day || winner.day.d !== day) winner.day = { d: day, n: 0 };
  if (winner.day.n >= MAX_WINS_DAY || now - (winner.lastWin || 0) < MIN_WIN_GAP) return false;
  winner.day.n++; winner.lastWin = now; winner.credits = (winner.credits | 0) + WIN_CREDITS; persist();
  return true;
}

/* ---- slumpad matchning: spelare ställer sig i kö och paras ihop två och två ---- */
const seen = new Map();     // id -> senaste hjärtslag (spelare online)
function onlineCount() { const now = Date.now(); let n = 0; for (const [id, t] of seen) { if (now - t > 75000) seen.delete(id); else n++; } return n; }
const queue = new Map();
setInterval(() => { const now = Date.now(); for (const [id, e] of queue) if (now - e.t > (e.room ? 60000 : 9000)) queue.delete(id); }, 3000);
function queueApi(m) {
  const id = String(m.id || ''); if (!/^[a-zA-Z0-9]{8,32}$/.test(id)) return { err: 'bad' };
  const now = Date.now();
  if (m.act === 'leave') { const e = queue.get(id); if (e && !e.room) queue.delete(id); return { ok: 1 }; }
  let e = queue.get(id);
  if (m.act === 'join') {
    if (!e) { if (queue.size >= 1000) return { err: 'full' }; e = { t: now, room: null, host: false }; queue.set(id, e); }
    e.t = now;
    if (!e.room) {
      let other = null;
      for (const [oid, o] of queue) if (oid !== id && !o.room && now - o.t <= 9000 && (!other || o.t < other[1].t)) other = [oid, o];
      if (other) {
        const room = 'q' + crypto.randomBytes(4).toString('hex').slice(0, 6);
        other[1].room = room; other[1].host = true; e.room = room; e.host = false;
      }
    }
  } else if (!e) return { state: 'none' };
  else e.t = now;
  if (e.room) return { room: e.room, host: e.host };
  let n = 0; for (const [, o] of queue) if (!o.room) n++;
  return { state: 'wait', waiting: n };
}
/* ---- Stripe: köp av krediter (kräver STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET) ---- */
const STRIPE_KEY = (process.env.STRIPE_SECRET_KEY || '').trim(), STRIPE_WH = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
if (STRIPE_KEY && !/^(sk|rk)_(test|live)_[A-Za-z0-9]{20,}$/.test(STRIPE_KEY)) console.error('stripe: STRIPE_SECRET_KEY är för kort eller felaktig (' + STRIPE_KEY.length + ' tecken). Hela nyckeln ska klistras in, den är över 100 tecken lång.');
if (STRIPE_WH && !/^whsec_[A-Za-z0-9+\/=]{20,}$/.test(STRIPE_WH)) console.error('stripe: STRIPE_WEBHOOK_SECRET är för kort eller felaktig (' + STRIPE_WH.length + ' tecken).');
const STRIPE_API = (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/$/, '');
const CUR = (process.env.STRIPE_CURRENCY || 'sek').toLowerCase(), PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const PACKS = { p1: { credits: 1000, amount: 1900 }, p2: { credits: 3000, amount: 4900 }, p3: { credits: 6500, amount: 8900 }, p4: { credits: 15000, amount: 17900 } };   // amount i minsta valutaenhet (öre)
const PAY_ON = !!(STRIPE_KEY && STRIPE_WH);
const TAX_CODE = (process.env.STRIPE_TAX_CODE || '').trim();   // valfri: Stripes produktskattekod (txcd_…) om du använder Managed Payments
function enc(o, pre, out) {
  out = out || [];
  for (const k of Object.keys(o)) { const key = pre ? pre + '[' + k + ']' : k, v = o[k]; if (v && typeof v === 'object') enc(v, key, out); else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v))); }
  return out;
}
function stripePost(p, params) {
  return new Promise((resolve, reject) => {
    const u = new URL(STRIPE_API + p), body = enc(params).join('&');
    const r = (u.protocol === 'http:' ? http : require('https')).request(u, { method: 'POST', headers: { Authorization: 'Bearer ' + STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, timeout: 15000 }, resp => {
      const ch = []; resp.on('data', d => ch.push(d));
      resp.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch (_) { } if (resp.statusCode >= 200 && resp.statusCode < 300 && j) resolve(j); else reject(new Error('stripe ' + resp.statusCode + ' ' + ((j && j.error && j.error.message) || ''))); });
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('stripe timeout'))); r.end(body);
  });
}
const coHits = new Map();
function coLimited(name) { const now = Date.now(), a = (coHits.get(name) || []).filter(t => now - t < 60000); a.push(now); coHits.set(name, a); return a.length > 8; }
function readRaw(req, cb) {
  let n = 0; const ch = [];
  req.on('data', d => { n += d.length; if (n > 1000000) { req.destroy(); return; } ch.push(d); });
  req.on('end', () => cb(Buffer.concat(ch).toString('utf8')));
}
function stripeEvent(ev) {
  const o = (ev && ev.data && ev.data.object) || {}, md = o.metadata || {};
  if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
    if (o.payment_status !== 'paid') return;
    const u = users[String(md.user || '').toLowerCase()], pk = PACKS[md.pack];
    if (!u || !pk || o.amount_total !== pk.amount || String(o.currency || '').toLowerCase() !== CUR) { console.error('stripe: orimlig betalning', o.id); return; }
    u.paid = u.paid || {}; if (u.paid[o.id]) return;                       // redan krediterad (Stripe kan skicka samma händelse flera gånger)
    u.credits = (u.credits | 0) + pk.credits; u.paid[o.id] = { t: Date.now(), pack: md.pack, credits: pk.credits, pi: o.payment_intent || '' }; persist();
    console.log('stripe: +' + pk.credits + ' krediter till ' + u.name);
  } else if ((ev.type === 'charge.refunded' && o.refunded === true) || ev.type === 'charge.dispute.created') {
    const pi = o.payment_intent; if (!pi) return;
    for (const u of Object.values(users)) for (const id in (u.paid || {})) {
      const e = u.paid[id];
      if (e.pi === pi && !e.refunded) { e.refunded = Date.now(); u.credits = Math.max(0, (u.credits | 0) - e.credits); persist(); console.log('stripe: återbetalning, -' + e.credits + ' krediter från ' + u.name); }
    }
  }
}
function stripeHook(req, res, raw) {
  if (!PAY_ON) return json(res, 503, { err: 'nopay' });
  let t = 0; const v1 = [];
  for (const part of String(req.headers['stripe-signature'] || '').split(',')) { const i = part.indexOf('='); if (i < 0) continue; const k = part.slice(0, i), v = part.slice(i + 1); if (k === 't') t = parseInt(v, 10); else if (k === 'v1') v1.push(v); }
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return json(res, 400, { err: 'sig' });
  const exp = crypto.createHmac('sha256', STRIPE_WH).update(t + '.' + raw).digest('hex');
  if (!v1.some(x => x.length === exp.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(exp)))) return json(res, 400, { err: 'sig' });
  let ev; try { ev = JSON.parse(raw); } catch (_) { return json(res, 400, { err: 'bad' }); }
  try { stripeEvent(ev); } catch (e) { console.error(e); return json(res, 500, { err: 'server' }); }
  json(res, 200, { received: true });
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
    const av = /^\d{1,2}(\.\d{1,2}){5}$/.test(d['pool8.av'] || '') ? d['pool8.av'] : '';
    return { name: u.name, av, trophies: Object.keys(tr).length, stars, won: st.mpWon | 0, streak: st.bestStreak | 0, pots: st.pots | 0, clear: bi('pool8.best.clear'), nine: bi('pool8.best.nine') };
  });
  const LOW = { clear: 1, nine: 1 }, cats = {}, ml = String(me || '').toLowerCase();
  for (const key of ['trophies', 'stars', 'won', 'streak', 'clear', 'nine', 'pots']) {
    const list = rows.filter(r => r[key] > 0).sort((a, b) => (LOW[key] ? a[key] - b[key] : b[key] - a[key]) || a.name.localeCompare(b.name));
    const idx = ml ? list.findIndex(r => r.name.toLowerCase() === ml) : -1;
    cats[key] = { top: list.slice(0, 10).map(r => ({ name: r.name, av: r.av, v: r[key] })), me: idx >= 0 ? { rank: idx + 1, v: list[idx][key] } : null, n: list.length };
  }
  return { cats };
}
function api(req, res, p) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.method === 'GET') { if (p === '/api/ping') return json(res, 200, { ok: 1, pay: PAY_ON, cur: CUR, packs: PAY_ON ? Object.keys(PACKS).map(id => ({ id, credits: PACKS[id].credits, amount: PACKS[id].amount })) : [] }); if (p === '/api/board') return json(res, 200, board(new URL(req.url, 'http://x').searchParams.get('me'))); return json(res, 404, { err: 'nf' }); }
  if (req.method !== 'POST') return json(res, 405, { err: 'method' });
  if (p === '/api/stripe-webhook') return readRaw(req, raw => stripeHook(req, res, raw));
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
          u = users[key] = { name, salt, hash: await scrypt(pw, salt), created: Date.now(), data: {}, upd: 0, credits: 0, owned: {} }; persist();
        } else {
          const h = u ? await scrypt(pw, u.salt) : null;
          if (!u || h.length !== u.hash.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.hash))) return json(res, 401, { err: 'bad_login' });
        }
        return json(res, 200, { token: mkToken(u.name), name: u.name, data: u.data, upd: u.upd, eco: eco(u) });
      }
      if (p === '/api/queue') return json(res, 200, queueApi(m));
      if (p === '/api/hb') {
        const id = String(m.id || '');
        if (/^[a-zA-Z0-9]{8,32}$/.test(id)) { if (m.bye) seen.delete(id); else if (seen.size < 20000 || seen.has(id)) seen.set(id, Date.now()); }
        return json(res, 200, { online: onlineCount() });
      }
      if (p === '/api/admin') {                       // bara för ägaren: kräver miljövariabeln ADMIN_KEY
        const K = process.env.ADMIN_KEY || '';
        if (limited(ip)) return json(res, 429, { err: 'rate' });
        const a1 = Buffer.from(String(m.key || '')), b1 = Buffer.from(K);
        if (!K || a1.length !== b1.length || !crypto.timingSafeEqual(a1, b1)) return json(res, 403, { err: 'forbidden' });
        const t = users[String(m.name || '').toLowerCase()], n = parseInt(m.amount, 10);
        if (!t || !Number.isFinite(n) || Math.abs(n) > 1e6) return json(res, 400, { err: 'bad' });
        t.credits = Math.max(0, (t.credits | 0) + n); persist();
        return json(res, 200, { ok: 1, name: t.name, credits: t.credits });
      }
      const u = verToken(m.token);
      if (!u) return json(res, 401, { err: 'auth' });
      if (p === '/api/checkout') {
        if (!PAY_ON) return json(res, 503, { err: 'nopay' });
        const id = String(m.pack || ''), pk = PACKS[id]; if (!pk) return json(res, 400, { err: 'bad_pack' });
        if (coLimited(u.name.toLowerCase())) return json(res, 429, { err: 'rate' });
        const host = String(req.headers.host || ''), proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https' ? 'https' : 'http';
        const origin = PUBLIC_URL || (/^[a-zA-Z0-9.:-]{1,100}$/.test(host) ? proto + '://' + host : '');
        if (!origin) return json(res, 400, { err: 'bad' });
        try {
          const ses = await stripePost('/v1/checkout/sessions', Object.assign({ mode: 'payment', success_url: origin + '/?paid=1', cancel_url: origin + '/?paid=0', client_reference_id: u.name, metadata: { user: u.name, pack: id }, line_items: { 0: { quantity: 1, price_data: { currency: CUR, unit_amount: pk.amount, product_data: Object.assign({ name: pk.credits + ' krediter – Poolers' }, TAX_CODE ? { tax_code: TAX_CODE } : {}) } } } }, TAX_CODE ? {} : { managed_payments: { enabled: 'false' } }));
          return json(res, 200, { url: ses.url });
        } catch (e) { console.error(e.message); return json(res, 502, { err: 'stripe' }); }
      }
      if (p === '/api/me') return json(res, 200, { name: u.name, data: u.data, upd: u.upd, eco: eco(u) });
      if (p === '/api/result') { const ok = report(u, String(m.mid || ''), m.res); return json(res, 200, { ok: 1, credited: ok, eco: eco(u) }); }
      if (p === '/api/buy') {
        const item = String(m.item || ''), pr = price(item);
        if (pr === null) return json(res, 400, { err: 'bad_item' });
        u.owned = u.owned || {};
        if (pr === 0 || u.owned[item]) return json(res, 200, { ok: 1, eco: eco(u) });
        if ((u.credits | 0) < pr) return json(res, 402, { err: 'poor', need: pr - (u.credits | 0), eco: eco(u) });
        u.credits -= pr; u.owned[item] = Date.now(); persist();
        return json(res, 200, { ok: 1, eco: eco(u) });
      }
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
  console.log('Poolers körs på:\n  http://localhost:' + PORT + (ips.length ? '\n' + ips.map(i => '  http://' + i + ':' + PORT + '  (samma wifi)').join('\n') : ''));
});
