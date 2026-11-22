// 8-Ball Pool – egen server. Inga beroenden: kör bara `node server.js`.
// Serverar spelet och skickar vidare meddelanden mellan spelarna i samma rum (WebSocket).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/health') { res.writeHead(200); return res.end('ok'); }
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
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
