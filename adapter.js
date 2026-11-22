/* Ersätter claude.ai:s rumsfunktion med en vanlig WebSocket mot den egna servern. */
(() => {
  if (window.claude) return;
  const myPeer = 'p' + Math.random().toString(36).slice(2, 10);
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  let ws = null, open = false, queue = [];
  const rooms = new Map();
  function connect() {
    ws = new WebSocket(proto + location.host + '/ws');
    ws.onopen = () => { open = true; queue.forEach(q => ws.send(q)); queue = []; rooms.forEach(r => r._hello()); };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } const r = rooms.get(m.room); if (r) r._in(m); };
    ws.onclose = () => { open = false; setTimeout(connect, 1500); };
    ws.onerror = () => { try { ws.close(); } catch (_) { } };
  }
  function tx(o) { const s = JSON.stringify(o); if (open) ws.send(s); else if (queue.length < 50) queue.push(s); }
  function mk(name) {
    const st = { handlers: {}, pf: [], others: new Map(), peers: [] };
    const me = { peer: myPeer, by: null, isMe: true, sameTab: true, kind: 'viewer', guest: false, presence: {}, updatedAt: 0 };
    const send = m => tx(Object.assign({ room: name, from: myPeer }, m));
    const snap = () => [me].concat([...st.others.values()]);
    const fire = ch => { st.peers = snap(); st.pf.slice().forEach(f => f(Object.assign({ peers: st.peers, joined: [], left: [], updated: [] }, ch))); };
    const r = {
      name,
      _hello: () => send({ t: 'hello', pres: me.presence }),
      _in(m) {
        if (m.from === myPeer) return;
        if (m.t === 'hello') {
          const p = { peer: m.from, by: null, isMe: false, sameTab: false, kind: 'viewer', guest: false, presence: m.pres || {}, updatedAt: Date.now() };
          const isNew = !st.others.has(m.from); st.others.set(m.from, p);
          if (isNew) { send({ t: 'hello', pres: me.presence }); setTimeout(() => fire({ joined: [p] }), 0); }
        } else if (m.t === 'pres') {
          const p = st.others.get(m.from); if (p) { const np = Object.assign({}, p, { presence: m.pres || {}, updatedAt: Date.now() }); st.others.set(m.from, np); fire({ updated: [np] }); }
        } else if (m.t === 'bye') {
          const p = st.others.get(m.from); st.others.delete(m.from); if (p) fire({ left: [p] });
        } else if (m.t === 'ev') {
          (st.handlers[m.topic] || []).slice().forEach(h => h({ topic: m.topic, data: m.data, peer: m.from, by: null, isMe: false, sameTab: false, kind: 'viewer', guest: false }));
        }
      },
      emit: async (t, d) => { send({ t: 'ev', topic: t, data: d === undefined ? null : JSON.parse(JSON.stringify(d)) }); },
      on: (t, h) => { (st.handlers[t] = st.handlers[t] || []).push(h); return () => { st.handlers[t] = (st.handlers[t] || []).filter(x => x !== h); }; },
      presence: async p => { me.presence = Object.assign({}, me.presence, p); send({ t: 'pres', pres: me.presence }); },
      peers: () => st.peers.length ? st.peers : snap(),
      onPeers: f => { st.pf.push(f); setTimeout(() => fire({ joined: snap() }), 0); return () => { st.pf = st.pf.filter(x => x !== f); }; },
      connected: () => open, onConnection: () => () => { },
      leave: async () => { send({ t: 'bye' }); rooms.delete(name); }
    };
    rooms.set(name, r);
    r._hello();
    return r;
  }
  connect();
  window.claude = { use: async n => n === 'room' ? { join: async name => rooms.get(name) || mk(name) } : null };
})();
