'use strict';
const express = require('express');
const { catalog } = require('./store');
const MAX_DECKS = 12;

function validDeck(d, inv) {
  if (!d || typeof d !== 'object' || !d.chars || !d.skills) return '形式が不正です';
  let nc = 0, ns = 0;
  for (const [k, n] of Object.entries(d.chars)) {
    if (!(k in catalog.chars)) return '不明なキャラがあります';
    if (!Number.isInteger(n) || n < 1 || n > catalog.chars[k]) return 'キャラの枚数が不正です';
    if (n > (inv.chars[k] || 0)) return '持っていないカードが含まれています';
    nc += n;
  }
  for (const [k, n] of Object.entries(d.skills)) {
    if (!(k in catalog.skills)) return '不明なスキルがあります';
    if (!Number.isInteger(n) || n < 1 || n > catalog.skills[k]) return 'スキルの枚数が不正です';
    if (n > (inv.skills[k] || 0)) return '持っていないカードが含まれています';
    ns += n;
  }
  if (nc > 20 || ns > 30) return '枚数が多すぎます';
  if (Object.entries(d.chars).reduce((a, [k, n]) => a + (catalog.rar[k] === 3 ? n : 0), 0) > catalog.bigMax) return 'レア3は' + catalog.bigMax + '枚までです';
  if (d.ab && !catalog.abilities.includes(d.ab)) return '不明な能力です';
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

function router(store) {
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
  r.put('/decks/:name', auth, wrap(async (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name || name.length > 20) return res.status(400).json({ error: 'デッキ名は1〜20文字です' });
    const inv = await store.inventory(req.player.id), err = validDeck(req.body, inv);
    if (err) return res.status(400).json({ error: err });
    if (!(await store.hasDeck(req.player.id, name)) && (await store.deckCount(req.player.id)) >= MAX_DECKS) return res.status(400).json({ error: 'デッキは' + MAX_DECKS + '個までです' });
    await store.putDeck(req.player.id, name, req.body); res.json({ ok: true });
  }));
  r.delete('/decks/:name', auth, wrap(async (req, res) => { await store.delDeck(req.player.id, req.params.name); res.json({ ok: true }); }));
  return r;
}
module.exports = { router, validDeck };
