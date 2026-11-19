'use strict';
const express = require('express');
const { catalog } = require('./store');
const MAX_DECKS = 12;

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function validDeck(d, inv) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || !d.chars || !d.skills || typeof d.chars !== 'object' || typeof d.skills !== 'object' || Array.isArray(d.chars) || Array.isArray(d.skills)) return '形式が不正です';
  let nc = 0, ns = 0;
  for (const [k, n] of Object.entries(d.chars)) {
    if (!own(catalog.chars, k)) return '不明なキャラがあります';
    if (!Number.isInteger(n) || n < 1 || n > catalog.chars[k]) return 'キャラの枚数が不正です';
    if (n > (own(inv.chars, k) ? inv.chars[k] : 0)) return '持っていないカードが含まれています';
    nc += n;
  }
  for (const [k, n] of Object.entries(d.skills)) {
    if (!own(catalog.skills, k)) return '不明なスキルがあります';
    if (!Number.isInteger(n) || n < 1 || n > catalog.skills[k]) return 'スキルの枚数が不正です';
    if (n > (own(inv.skills, k) ? inv.skills[k] : 0)) return '持っていないカードが含まれています';
    ns += n;
  }
  if (nc > 20 || ns > 30) return '枚数が多すぎます';
  if (Object.entries(d.chars).reduce((a, [k, n]) => a + (catalog.rar[k] >= 3 ? n : 0), 0) > catalog.bigMax) return 'レア3以上は' + catalog.bigMax + '枚までです';
  if (d.ab) {
    const al = Array.isArray(d.ab) ? d.ab : [d.ab];
    if (al.length > 10 || al.some(k => typeof k !== 'string' || !catalog.abilities.includes(k))) return '不明な能力です';
    if (new Set(al).size !== al.length) return '同じ能力は重複できません';
    if (al.reduce((t, k) => t + catalog.abcost[k], 0) > catalog.abBudget) return '能力コストの合計は' + catalog.abBudget + 'までです';
  }
  return null;
}

function limiter(max, ms) {
  const hits = new Map();
  return (req, res, next) => {
    const k = req.ip, now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < ms);
    if (a.length >= max) return res.status(429).json({ error: '試行回数が多すぎます。しばらく待ってください。' });
    a.push(now); hits.set(k, a);
    if (hits.size > 5000) hits.clear();
    next();
  };
}

function router(store, alive, hub) {
  hub = hub || { state: () => 0, notify() {} };
  const r = express.Router();
  r.use(express.json({ limit: '32kb' }));
  const wrap = f => (req, res) => f(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); });
  const auth = wrap2(async (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const p = m && await store.byToken(m[1]);
    if (!p) return res.status(401).json({ error: '認証が必要です' });
    req.player = p; next();
  });
  function wrap2(f) { return (req, res, next) => f(req, res, next).catch(e => { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }); }

  r.get('/ping', (req, res) => res.json({ ok: true, db: store.kind }));
  r.post('/guest', limiter(20, 3600e3), wrap(async (req, res) => {
    const p = await store.createPlayer(req.body && req.body.name);
    res.json({ token: p.token, recovery: p.recovery, player: { id: p.id, name: String((req.body && req.body.name) || 'プレイヤー').slice(0, 16) } });
  }));
  r.post('/recover', limiter(10, 600e3), wrap(async (req, res) => {
    const p = await store.recover(req.body && req.body.code);
    if (!p) return res.status(404).json({ error: '引き継ぎコードが見つかりません' });
    res.json({ token: p.token, player: { id: p.id, name: p.name } });
  }));
  r.get('/me', auth, wrap(async (req, res) => res.json({ player: { id: req.player.id, name: req.player.name } })));
  r.patch('/me', auth, wrap(async (req, res) => {
    const n = String((req.body && req.body.name) || '').trim();
    if (!n) return res.status(400).json({ error: '名前が空です' });
    await store.rename(req.player.id, n); res.json({ ok: true });
  }));
  r.post('/me/recovery', auth, wrap(async (req, res) => res.json({ recovery: await store.newRecovery(req.player.id) })));
  r.get('/decks', auth, wrap(async (req, res) => res.json({ decks: await store.listDecks(req.player.id) })));
  r.get('/inventory', auth, wrap(async (req, res) => res.json(await store.inventory(req.player.id))));
  const gres = (res, o) => o.error ? res.status(400).json(o) : res.json(o);
  const gl = limiter(120, 60e3);
  r.get('/gacha', auth, gl, wrap(async (req, res) => res.json(await store.gachaState(req.player.id))));
  r.post('/gacha/open', auth, gl, wrap(async (req, res) => gres(res, await store.gachaOpen(req.player.id, String((req.body && req.body.pack) || '')))));
  r.post('/gacha/convert', auth, gl, wrap(async (req, res) => gres(res, await store.gachaConvert(req.player.id))));
  r.post('/gacha/exchange', auth, gl, wrap(async (req, res) => gres(res, await store.gachaExchange(req.player.id, String((req.body && req.body.kind) || ''), String((req.body && req.body.key) || '')))));
  r.post('/reward/cpu', auth, gl, wrap(async (req, res) => res.json(await store.rewardCpu(req.player.id))));
  r.post('/reward/pvp', auth, gl, wrap(async (req, res) => res.json(await store.rewardPvp(req.player.id, String((req.body && req.body.match) || ''), String((req.body && req.body.result) || '')))));
  r.post('/news/read', auth, gl, wrap(async (req, res) => gres(res, await store.newsRead(req.player.id, String((req.body && req.body.id) || '')))));
  r.post('/news/claim', auth, gl, wrap(async (req, res) => gres(res, await store.newsClaim(req.player.id, String((req.body && req.body.id) || ''), String((req.body && req.body.pick) || '')))));
  const B = req => req.body || {};
  r.get('/news', auth, gl, wrap(async (req, res) => res.json({ items: await store.newsList(req.player.id), inbox: await store.inbox(req.player.id, alive) })));
  r.get('/friends', auth, gl, wrap(async (req, res) => res.json(await store.friendsView(req.player.id, hub.state))));
  r.post('/friends/request', auth, gl, wrap(async (req, res) => { const o = await store.friendRequest(req.player.id, String(B(req).code || '')); if (o.ok && o.status === 'sent') hub.notify(o.to, { k: 'req', name: req.player.name }); delete o.to; gres(res, o); }));
  r.post('/friends/accept', auth, gl, wrap(async (req, res) => { const o = await store.friendAccept(req.player.id, String(B(req).code || '')); if (o.ok && o.to) hub.notify(o.to, { k: 'fr' }); delete o.to; gres(res, o); }));
  r.post('/friends/decline', auth, gl, wrap(async (req, res) => { const o = await store.friendDecline(req.player.id, String(B(req).code || '')); if (o.ok && o.to) hub.notify(o.to, { k: 'fr' }); delete o.to; gres(res, o); }));
  r.post('/friends/cancel', auth, gl, wrap(async (req, res) => { const o = await store.friendCancel(req.player.id, String(B(req).code || '')); if (o.ok && o.to) hub.notify(o.to, { k: 'fr' }); delete o.to; gres(res, o); }));
  r.post('/friends/remove', auth, gl, wrap(async (req, res) => { const o = await store.friendRemove(req.player.id, String(B(req).code || '')); if (o.ok && o.to) hub.notify(o.to, { k: 'fr' }); delete o.to; gres(res, o); }));
  r.post('/invites', auth, gl, wrap(async (req, res) => { const o = await store.inviteSend(req.player.id, String(B(req).code || ''), String(B(req).room || ''), alive); if (o.ok) hub.notify(o.to, { k: 'invite', name: req.player.name }); delete o.to; gres(res, o); }));
  r.post('/invites/join', auth, gl, wrap(async (req, res) => gres(res, await store.inviteJoin(req.player.id, String(B(req).id || ''), alive))));
  r.post('/inbox/seen', auth, gl, wrap(async (req, res) => gres(res, await store.inboxSeen(req.player.id))));
  // 公開デッキ
  const pubDeck = async (req, res) => {
    const b = B(req), inv = await store.inventory(req.player.id), err = validDeck(b.deck, inv);
    if (err) { res.status(400).json({ error: err }); return null; }
    const nc = Object.values(b.deck.chars).reduce((a, n) => a + n, 0), ns = Object.values(b.deck.skills).reduce((a, n) => a + n, 0);
    if (nc !== 20 || ns !== 30) { res.status(400).json({ error: '公開できるのは、キャラ20枚・スキル30枚そろったデッキです' }); return null; }
    return { chars: b.deck.chars, skills: b.deck.skills, ab: b.deck.ab || null };
  };
  r.get('/pub', auth, gl, wrap(async (req, res) => res.json(await store.pubList(req.player.id, String(req.query.sort || 'new')))));
  r.post('/pub', auth, gl, wrap(async (req, res) => { const d = await pubDeck(req, res); if (d) gres(res, await store.pubCreate(req.player.id, B(req).title, B(req).comment, d)); }));
  r.put('/pub/:id', auth, gl, wrap(async (req, res) => {
    let d = null; if (B(req).deck) { d = await pubDeck(req, res); if (!d) return; }
    gres(res, await store.pubUpdate(req.player.id, String(req.params.id), B(req).title, B(req).comment, d));
  }));
  r.delete('/pub/:id', auth, gl, wrap(async (req, res) => gres(res, await store.pubDelete(req.player.id, String(req.params.id)))));
  r.post('/pub/:id/save', auth, gl, wrap(async (req, res) => gres(res, await store.pubSave(req.player.id, String(req.params.id)))));
  r.delete('/pub/:id/save', auth, gl, wrap(async (req, res) => gres(res, await store.pubUnsave(req.player.id, String(req.params.id)))));
  r.post('/pub/:id/result', auth, gl, wrap(async (req, res) => gres(res, await store.pubResult(req.player.id, String(req.params.id), String(B(req).result || ''), B(req).with ? String(B(req).with) : null))));
  r.put('/decks/:name', auth, wrap(async (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name || name.length > 20) return res.status(400).json({ error: 'デッキ名は1〜20文字です' });
    const inv = await store.inventory(req.player.id), err = validDeck(req.body, inv);
    if (err) return res.status(400).json({ error: err });
    if (!(await store.hasDeck(req.player.id, name)) && (await store.deckCount(req.player.id)) >= MAX_DECKS) return res.status(400).json({ error: 'デッキは' + MAX_DECKS + '個までです' });
    await store.putDeck(req.player.id, name, { chars: req.body.chars, skills: req.body.skills, ab: req.body.ab || null }); res.json({ ok: true });
  }));
  r.delete('/decks/:name', auth, wrap(async (req, res) => { await store.delDeck(req.player.id, req.params.name); res.json({ ok: true }); }));
  r.use((e, req, res, next) => { // JSONが壊れている・大きすぎる等。スタックトレースは返さない
    if (res.headersSent) return next(e);
    res.status(e.status && e.status < 500 ? e.status : 400).json({ error: 'リクエストが不正です' });
  });
  return r;
}
module.exports = { router, validDeck };
