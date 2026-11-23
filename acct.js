/* Konto + molnsparning (endast när spelet körs från egen server). */
(function () {
  var EXC = function (k) { return k.indexOf('pool8.') !== 0 || k.indexOf('pool8.mt.') === 0 || k === 'pool8.acct' || k === 'pool8.q'; };
  var LS = window.localStorage, rawSet, rawDel;
  var A = null, timer = 0, pending = false, last = null, busy = false;
  try { A = JSON.parse(LS.getItem('pool8.acct') || 'null'); } catch (_) { }
  if (A && !(A.token && A.name)) A = null;
  var ECO = window.__eco = { on: false, ready: !A, credits: 0, owned: {}, name: '' };
  function setEco(e, quiet) {
    var old = ECO.credits; ECO.ready = !A || !!e;
    ECO.credits = e ? (e.credits | 0) : 0; ECO.owned = {}; ((e && e.owned) || []).forEach(function (k) { ECO.owned[k] = 1; });
    ECO.name = A ? A.name : '';
    var chip = $('h-credits'); if (chip) { chip.style.display = A && ECO.on ? 'flex' : 'none'; chip.textContent = '🪙 ' + ECO.credits; }
    if (window.__ecoChanged) window.__ecoChanged();
    if (!quiet && A && ECO.credits > old && window.__ecoToast) window.__ecoToast(ECO.credits - old);
  }
  window.__ecoBuy = function (item, cb) {
    if (!A) return cb(false);
    post('/api/buy', { token: A.token, item: item }, function (st, j) { if (j && j.eco) setEco(j.eco, true); cb(st === 200); });
  };
  window.__checkout = function (pack, cb) {
    if (!A) return cb(null, 'auth');
    post('/api/checkout', { token: A.token, pack: pack }, function (st, j) { if (st === 200 && j && j.url) cb(j.url); else cb(null, (j && j.err) || 'net'); });
  };
  window.__mpResult = function (mid, won) {
    if (!A || !ECO.on) return;
    post('/api/result', { token: A.token, mid: mid, res: won ? 'w' : 'l' }, function (st, j) { if (j && j.eco) setEco(j.eco, true); });
    if (won) [3000, 9000].forEach(function (ms) { setTimeout(function () { post('/api/me', { token: A.token }, function (s2, j2) { if (s2 === 200 && j2 && j2.eco) setEco(j2.eco); }); }, ms); });
  };
  var $ = function (id) { return document.getElementById(id); };
  var T = function (s, a) { return window.__tr ? window.__tr(s, a) : s; };

  function localData() { var o = {}; try { for (var i = 0; i < LS.length; i++) { var k = LS.key(i); if (!EXC(k)) o[k] = LS.getItem(k); } } catch (_) { } return o; }
  function num(v) { var n = parseInt(v, 10); return isNaN(n) ? null : n; }
  function jparse(s) { try { return JSON.parse(s); } catch (_) { return null; } }
  function mergeKey(k, a, b) {            // a = lokalt, b = moln
    if (a === undefined) return b; if (b === undefined) return a; if (a === b) return a;
    if (k === 'pool8.stats') {
      var x = jparse(a) || {}, y = jparse(b) || {}, o = {};
      Object.keys(x).concat(Object.keys(y)).forEach(function (f) { o[f] = f === 'since' ? Math.min(x[f] || Infinity, y[f] || Infinity) : Math.max(x[f] || 0, y[f] || 0); if (o[f] === Infinity) delete o[f]; });
      return JSON.stringify(o);
    }
    if (k === 'pool8.trophies') { var x1 = jparse(a) || {}, y1 = jparse(b) || {}, o1 = {}; Object.keys(x1).concat(Object.keys(y1)).forEach(function (f) { o1[f] = Math.min(x1[f] || Infinity, y1[f] || Infinity); }); return JSON.stringify(o1); }
    if (k === 'pool8.tc') { var x2 = jparse(a) || {}, y2 = jparse(b) || {}, o2 = {}; Object.keys(x2).concat(Object.keys(y2)).forEach(function (f) { o2[f] = Math.max(x2[f] || 0, y2[f] || 0); }); return JSON.stringify(o2); }
    if (k.indexOf('pool8.chal.') === 0) return String(Math.max(num(a) || 0, num(b) || 0));
    if (k.indexOf('pool8.best.') === 0) { var p = num(a), q = num(b); if (p === null) return b; if (q === null) return a; return String(k === 'pool8.best.oneball' ? Math.max(p, q) : Math.min(p, q)); }
    if (k.indexOf('pool8.ghost.') === 0) { var g = jparse(a), h = jparse(b); return g && h && g.n < h.n ? a : b; }
    return b;                              // inställningar: molnet vinner
  }
  function merge(loc, cloud) { var o = {}, k; for (k in loc) o[k] = loc[k]; for (k in cloud) o[k] = mergeKey(k, loc[k], cloud[k]); return o; }

  function post(path, body, cb, keep) {
    var x = new XMLHttpRequest();
    if (keep && window.fetch) { try { fetch(path, { method: 'POST', body: JSON.stringify(body), keepalive: true, headers: { 'Content-Type': 'application/json' } }); } catch (_) { } return; }
    x.open('POST', path); x.setRequestHeader('Content-Type', 'application/json');
    x.onload = function () { var j = null; try { j = JSON.parse(x.responseText); } catch (_) { } cb(x.status, j); };
    x.onerror = function () { cb(0, null); };
    x.send(JSON.stringify(body));
  }
  function setAcct(a) { A = a; ECO.name = a ? a.name : ''; try { if (a) LS.setItem('pool8.acct', JSON.stringify(a)); else LS.removeItem('pool8.acct'); } catch (_) { } ui(); }

  function push(now) {
    if (!A) return; pending = false; clearTimeout(timer);
    sync('sparar');
    post('/api/save', { token: A.token, data: localData() }, function (st, j) {
      if (st === 200) { last = Date.now(); sync('ok'); }
      else if (st === 401) { setAcct(null); msg('Sessionen har gått ut. Logga in igen.'); }
      else sync('fel');
    }, now === 'unload');
  }
  function sched() { if (!A) return; pending = true; clearTimeout(timer); timer = setTimeout(push, 4000); }
  function patch() {
    var P = Storage.prototype; rawSet = P.setItem; rawDel = P.removeItem;
    P.setItem = function (k, v) { rawSet.call(this, k, v); if (this === LS && !EXC(String(k))) sched(); };
    P.removeItem = function (k) { rawDel.call(this, k); if (this === LS && !EXC(String(k))) sched(); };
  }
  function flush() { if (pending && A) push('unload'); }

  function applyCloud(cloud, reload) {      // slå ihop, skriv lokalt, ladda upp, ladda om vid ändring
    var loc = localData(), m = merge(loc, cloud || {}), changed = false, k;
    for (k in m) if (loc[k] !== m[k]) { changed = true; rawSet.call(LS, k, m[k]); }
    try { if (LS.getItem('pool8.name') !== A.name) { changed = true; rawSet.call(LS, 'pool8.name', A.name); } } catch (_) { }
    push();
    if (changed && reload) setTimeout(function () { location.reload(); }, 400);
    return changed;
  }

  function msg(s, a, bad) { var e = $('ac-msg'); if (!e) return; e.textContent = s ? T(s, a) : ''; e.style.color = bad ? '#ff8a8a' : '#8fe3a8'; e.dataset.k = s || ''; e.dataset.bad = bad ? '1' : ''; }
  function sync(st) {
    var e = $('ac-sync'); if (!e) return; e.dataset.st = st;
    if (st === 'sparar') e.textContent = T('Sparar…');
    else if (st === 'ok') { var d = new Date(last || Date.now()); e.textContent = T('Sparad {0}', [d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })]); }
    else e.textContent = T('Kunde inte spara. Försöker igen vid nästa ändring.');
  }
  function ui() {
    var b = $('h-acct'); if (!b) return;
    var chip = $('h-credits'); if (chip) chip.style.display = A && ECO.on ? 'flex' : 'none';
    b.style.display = 'flex'; b.textContent = '';
    if (A && window.__avImg) { b.appendChild(window.__avImg(window.__avMine())); b.appendChild(document.createTextNode(A.name)); } else b.textContent = A ? '👤 ' + A.name : '👤 ' + T('Logga in');
    $('acct-out').style.display = A ? 'none' : ''; $('acct-in').style.display = A ? '' : 'none';
    if (A) { $('ac-who').textContent = T('Inloggad som {0}', [A.name]); var st = $('ac-sync').dataset.st; if (st) sync(st); else $('ac-sync').textContent = T('Din data sparas automatiskt.'); }
  }
  var CATS = [['trophies', 'Troféer', '🏅 '], ['stars', 'Utmaningsstjärnor', '★ '], ['won', 'Online: vunna', '🏆 '], ['streak', 'Längsta serie', '🔥 '], ['clear', 'Rensa bordet', '', ' skott'], ['nine', '9-ball', '', ' skott'], ['pots', 'Bollar sänkta', '🎱 ']];
  var bcat = 'trophies', bdata = null;
  function board() {
    var x = new XMLHttpRequest(); x.open('GET', '/api/board' + (A ? '?me=' + encodeURIComponent(A.name) : ''));
    x.onload = function () { bdata = jparse(x.responseText); drawBoard(); };
    x.onerror = function () { var m = $('board-msg'); if (m) m.textContent = T('Kunde inte nå servern.'); };
    x.send();
  }
  function drawBoard() {
    var tabs = $('board-tabs'), list = $('board-list'), msg2 = $('board-msg'); if (!tabs || !list) return;
    tabs.innerHTML = '';
    CATS.forEach(function (c) { var b = document.createElement('button'); b.textContent = T(c[1]); if (c[0] === bcat) b.className = 'on'; b.onclick = function () { bcat = c[0]; drawBoard(); }; tabs.appendChild(b); });
    list.innerHTML = ''; msg2.textContent = '';
    if (!bdata) { msg2.textContent = T('Laddar…'); return; }
    var def = CATS.filter(function (c) { return c[0] === bcat; })[0], cat = bdata.cats[bcat], fmt = function (v) { return (def[2] || '') + v + (def[3] ? ' ' + T('skott') : ''); };
    if (!cat.top.length) { msg2.textContent = T('Ingen än.'); return; }
    var medal = ['🥇', '🥈', '🥉'], meIn = false;
    cat.top.forEach(function (r, i) {
      var d = document.createElement('div'), me = A && r.name.toLowerCase() === A.name.toLowerCase(); if (me) meIn = true;
      d.className = 'brow' + (me ? ' me' : '');
      d.innerHTML = '<span class="rk"></span><span class="nm"></span><b class="vl"></b>';
      d.children[0].textContent = medal[i] || (i + 1) + '.'; d.children[1].textContent = r.name; d.children[2].textContent = fmt(r.v);
      if (window.__avImg && r.av) { var im = window.__avImg(r.av, 'avt'); d.insertBefore(im, d.children[1]); }
      list.appendChild(d);
    });
    if (A && !meIn && cat.me) {
      var e = document.createElement('div'); e.className = 'brow me'; e.innerHTML = '<span class="rk"></span><span class="nm"></span><b class="vl"></b>';
      e.children[0].textContent = '#' + cat.me.rank; e.children[1].textContent = A.name; e.children[2].textContent = fmt(cat.me.v); list.appendChild(e);
    }
  }
  function errMsg(st, j) {
    var c = j && j.err;
    var m = { bad_name: 'Namnet måste vara 3–16 tecken (bokstäver, siffror, _ eller -).', bad_pw: 'Lösenordet måste vara minst 6 tecken.', taken: 'Namnet är upptaget.', bad_login: 'Fel namn eller lösenord.', rate: 'För många försök. Vänta en stund.' }[c];
    msg(m || 'Kunde inte nå servern.', null, true);
  }
  function login(reg) {
    if (busy) return; var n = $('ac-name').value.trim(), p = $('ac-pw').value; busy = true; msg('Ansluter…');
    post(reg ? '/api/register' : '/api/login', { name: n, pw: p }, function (st, j) {
      busy = false;
      if (st !== 200 || !j) return errMsg(st, j);
      $('ac-pw').value = ''; setAcct({ token: j.token, name: j.name }); setEco(j.eco, true); last = null; $('ac-sync').dataset.st = '';
      msg(reg ? 'Kontot skapat!' : 'Inloggad!');
      if (window.__trophy) window.__trophy('acct');
      applyCloud(j.data, true);
    });
  }
  function init() {
    var b = $('h-acct'); if (!b) return;
    var x = new XMLHttpRequest(); x.open('GET', '/api/ping');
    x.onload = function () {
      if (x.status !== 200) return;
      var pj = jparse(x.responseText) || {}; ECO.pay = !!pj.pay; ECO.cur = pj.cur || 'sek'; ECO.packs = pj.packs || [];
      if (window.__quickShow) window.__quickShow();
      ECO.on = true; setEco(null, true); patch(); ui(); var hb = $('h-board'); if (hb) hb.style.display = '';
      $('ac-login').onclick = function () { login(false); }; $('ac-reg').onclick = function () { login(true); };
      $('ac-pw').onkeydown = function (e) { if (e.key === 'Enter') login(false); };
      $('ac-now').onclick = function () { push(); };
      $('ac-logout').onclick = function () { flush(); setAcct(null); setEco(null, true); msg('Utloggad.'); };
      window.__acctOpen = function () { ui(); }; window.__boardOpen = function () { bdata = null; drawBoard(); board(); };
      window.__acctRefresh = function () { ui(); var e = $('ac-msg'); if (e && e.dataset.k) msg(e.dataset.k, null, !!e.dataset.bad); drawBoard(); };
      document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
      window.addEventListener('pagehide', flush);
      if (A && /[?&]paid=1\b/.test(location.search)) {          // tillbaka från Stripe: hämta saldot några gånger tills betalningen registrerats
        try { history.replaceState(null, '', location.pathname); } catch (_) { }
        if (window.__payThanks) window.__payThanks();
        [1500, 4000, 8000, 15000, 30000].forEach(function (ms) { setTimeout(function () { post('/api/me', { token: A.token }, function (s2, j2) { if (s2 === 200 && j2 && j2.eco) setEco(j2.eco); }); }, ms); });
      }
      if (A) post('/api/me', { token: A.token }, function (st, j) {
        if (st === 200 && j) { setEco(j.eco, true); rawSet.call(LS, 'pool8.name', A.name); if (window.__trophy) window.__trophy('acct'); applyCloud(j.data, true); }
        else if (st === 401) { setAcct(null); setEco(null, true); }
      });
    };
    x.send();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
