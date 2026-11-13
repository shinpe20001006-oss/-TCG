'use strict';
/* 対戦の中継。ゲームの判定は両方のクライアントが同じ乱数で行い、サーバーは操作メッセージを相手に渡すだけ。
   (ガチャ・所持カードなどお金やデータに関わる処理は /api 側=サーバー判定) */
const { WebSocketServer } = require('ws');
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const rooms = new Map();
const code = () => { for (;;) { let c = ''; for (let i = 0; i < 5; i++) c += ALPHA[Math.floor(Math.random() * ALPHA.length)]; if (!rooms.has(c)) return c; } };

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  function leave(ws) {
    const r = ws.room; if (!r) return;
    ws.room = null; rooms.delete(r.code);
    const peer = r.a === ws ? r.b : r.a;
    if (peer) { send(peer, { t: 'peerleft' }); peer.room = null; }
  }
  wss.on('connection', ws => {
    ws.alive = true; ws.room = null; ws.hits = [];
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', raw => {
      const now = Date.now(); ws.hits = ws.hits.filter(t => now - t < 1000);
      if (ws.hits.push(now) > 2000) { ws.close(1008, 'rate'); return; } // 黙って捨てると対戦がずれるので、異常なときは切断する
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (!m || typeof m.t !== 'string') return;
      if (m.t === 'create') {
        if (ws.room) return;
        const c = code(); ws.room = { code: c, a: ws, b: null, at: now }; rooms.set(c, ws.room);
        send(ws, { t: 'created', code: c });
      } else if (m.t === 'join') {
        const r = rooms.get(String(m.code || '').toUpperCase());
        if (ws.room) return;
        if (!r || r.b) return send(ws, { t: 'error', msg: 'ルームが見つからないか、満員です。' });
        r.b = ws; ws.room = r;
        send(r.a, { t: 'joined', seat: 0 }); send(ws, { t: 'joined', seat: 1 });
      } else if (m.t === 'c' && ws.room) { // チャット: 対戦の同期とは無関係。100文字まで・2秒に1回まで(超過は捨てる)
        const peer = ws.room.a === ws ? ws.room.b : ws.room.a;
        const text = String(m.m == null ? '' : m.m).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100);
        if (!peer || !text || (ws.lastChat && now - ws.lastChat < 2000)) return;
        ws.lastChat = now; send(peer, { t: 'c', m: text });
      } else if ((m.t === 'g' || m.t === 'p') && ws.room) {
        const peer = ws.room.a === ws ? ws.room.b : ws.room.a;
        if (peer) { if (peer.readyState !== 1 && process.env.DEBUG_WS) console.log('[ws] peer not open', peer.readyState); peer.sentN = (peer.sentN || 0) + 1; send(peer, { t: m.t, s: m.s, m: m.m }); }
      }
    });
    ws.on('close', (c) => { if (process.env.DEBUG_WS) console.log('[ws] close', c, !!ws.room); leave(ws); });
    ws.on('error', () => {});
  });
  const hb = setInterval(() => {
    wss.clients.forEach(ws => { if (!ws.alive) { if (process.env.DEBUG_WS) console.log('[ws] terminate (no pong)'); return ws.terminate(); } ws.alive = false; try { ws.ping(); } catch (e) {} });
    const now = Date.now();
    rooms.forEach((r, c) => { if (!r.b && now - r.at > 2 * 3600e3) { rooms.delete(c); if (r.a) r.a.room = null; } });
  }, 25000);
  wss.on('close', () => clearInterval(hb));
  return wss;
}
module.exports = { attach, rooms };
