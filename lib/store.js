'use strict';
/* 保存層。本番は PostgreSQL(Neon など)。DATABASE_URL が無いとき、開発・テストではメモリ上のpg-memを使う。
   マイグレーションは「追加のみ」。既存のテーブルや列を消さないので、コードを更新してもデータは残る。 */
const crypto = require('crypto');
const catalog = require('./catalog.json');

const MIGRATIONS = [
  // v1: 初期スキーマ
  [
    `CREATE TABLE IF NOT EXISTS players(
       id TEXT PRIMARY KEY, name TEXT NOT NULL, recovery_hash TEXT NOT NULL UNIQUE,
       starter_ver INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS tokens(
       token_hash TEXT PRIMARY KEY, player_id TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS decks(
       player_id TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT now(),
       PRIMARY KEY(player_id,name))`,
    `CREATE TABLE IF NOT EXISTS inventory(
       player_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, qty INTEGER NOT NULL,
       PRIMARY KEY(player_id,kind,key))`,
  ],
  // v2: ガチャ(エナジー・天井)
  [
    `CREATE TABLE IF NOT EXISTS gacha(
       player_id TEXT PRIMARY KEY, energy INTEGER NOT NULL, energy_t BIGINT NOT NULL,
       pity INTEGER NOT NULL DEFAULT 0, opened INTEGER NOT NULL DEFAULT 0)`,
  ],
  // 今後の変更は、ここに配列を足していく。既存の配列は絶対に書き換えない。
];
const STARTER_VER = 2; // v2: ガチャ導入。この版より古いアカウントは1回だけ「スターターのみ」にリセット。※むやみに上げない(上げると全員のカードが再度リセットされる)
const G = require('./gacha');

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const PEPPER = process.env.CODE_PEPPER || '';
const hashToken = t => sha('t:' + t);
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = c => sha('r:' + PEPPER + normCode(c));
const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function randCode(n) { const b = crypto.randomBytes(n); let o = ''; for (let i = 0; i < n; i++) o += ALPHA[b[i] % 32]; return o; }
const newRecovery = () => { const c = randCode(12); return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8); };

async function makePool(url) {
  if (url) {
    const { Pool } = require('pg');
    const ssl = /sslmode=disable|localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    return { pool: new Pool({ connectionString: url, ssl, max: 5 }), kind: 'postgres' };
  }
  if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL が未設定です。本番ではデータ保護のため起動を拒否します。');
  const { newDb } = require('pg-mem');
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  console.warn('[store] DATABASE_URL 未設定: メモリ上の一時DBを使います(再起動で消えます)');
  return { pool: new Pool(), kind: 'memory' };
}

async function open(url) {
  const { pool, kind } = await makePool(url);
  const q = async (text, params) => (await pool.query(text, params)).rows;
  await q('CREATE TABLE IF NOT EXISTS schema_version(id INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
  let cur = (await q('SELECT version FROM schema_version WHERE id=1'))[0];
  let v = cur ? cur.version : 0;
  for (let i = v; i < MIGRATIONS.length; i++) {
    for (const sql of MIGRATIONS[i]) await q(sql);
    if (i === 0 && !cur) { await q('INSERT INTO schema_version(id,version) VALUES(1,$1)', [i + 1]); cur = { version: i + 1 }; }
    else await q('UPDATE schema_version SET version=$1 WHERE id=1', [i + 1]);
  }

  async function grantStarter(pid) {
    // スターターのみ配る(旧版で全カードを持っていたアカウントも、ここで作り直す)
    await q('DELETE FROM inventory WHERE player_id=$1', [pid]);
    await q('DELETE FROM decks WHERE player_id=$1', [pid]);
    for (const [k, n] of Object.entries(catalog.starter.chars)) await q('INSERT INTO inventory(player_id,kind,key,qty) VALUES($1,$2,$3,$4)', [pid, 'char', k, n]);
    for (const [k, n] of Object.entries(catalog.starter.skills)) await q('INSERT INTO inventory(player_id,kind,key,qty) VALUES($1,$2,$3,$4)', [pid, 'skill', k, n]);
    await q('DELETE FROM gacha WHERE player_id=$1', [pid]);
    await q('INSERT INTO gacha(player_id,energy,energy_t,pity,opened) VALUES($1,$2,$3,0,0)', [pid, G.E_START, Date.now()]);
    await q('UPDATE players SET starter_ver=$1 WHERE id=$2', [STARTER_VER, pid]);
  }
  // 同じプレイヤーのガチャ操作は1つずつ順番に(連打・二重送信での不正を防ぐ)
  const locks = new Map();
  const withLock = (pid, f) => {
    const prev = locks.get(pid) || Promise.resolve();
    const run = prev.then(f, f);
    const tail = run.catch(() => {}); locks.set(pid, tail);
    tail.then(() => { if (locks.get(pid) === tail) locks.delete(pid); });
    return run;
  };
  async function invOf(pid) {
    const o = { chars: {}, skills: {} };
    (await q('SELECT kind,key,qty FROM inventory WHERE player_id=$1', [pid])).forEach(r => { o[r.kind === 'char' ? 'chars' : 'skills'][r.key] = r.qty; });
    return o;
  }
  async function setQty(pid, kind, key, qty, had) {
    if (qty <= 0) await q('DELETE FROM inventory WHERE player_id=$1 AND kind=$2 AND key=$3', [pid, kind, key]);
    else if (had) await q('UPDATE inventory SET qty=$1 WHERE player_id=$2 AND kind=$3 AND key=$4', [qty, pid, kind, key]);
    else await q('INSERT INTO inventory(player_id,kind,key,qty) VALUES($1,$2,$3,$4)', [pid, kind, key, qty]);
  }
  async function gstate(pid) {
    let r = (await q('SELECT energy,energy_t,pity,opened FROM gacha WHERE player_id=$1', [pid]))[0];
    if (!r) { await q('INSERT INTO gacha(player_id,energy,energy_t,pity,opened) VALUES($1,$2,$3,0,0)', [pid, G.E_START, Date.now()]); r = { energy: G.E_START, energy_t: Date.now(), pity: 0, opened: 0 }; }
    return { energy: +r.energy, t: +r.energy_t, pity: +r.pity, opened: +r.opened };
  }
  const gsave = (pid, s) => q('UPDATE gacha SET energy=$1,energy_t=$2,pity=$3,opened=$4 WHERE player_id=$5', [s.energy, s.t, s.pity, s.opened, pid]);
  const view = (s, inv) => ({ energy: s.energy, nextMs: G.nextMs(s), pity: s.pity, opened: s.opened, cap: G.E_CAP, cost: G.PACK_COST, pityN: G.PITY_N, inv });

  return {
    kind,
    rawQuery: q, // テスト用
    close: () => pool.end(),
    async createPlayer(name) {
      const id = crypto.randomBytes(8).toString('hex'), token = crypto.randomBytes(24).toString('hex'), rec = newRecovery();
      await q('INSERT INTO players(id,name,recovery_hash) VALUES($1,$2,$3)', [id, String(name || 'プレイヤー').slice(0, 16), hashCode(rec)]);
      await q('INSERT INTO tokens(token_hash,player_id) VALUES($1,$2)', [hashToken(token), id]);
      await grantStarter(id);
      return { id, token, recovery: rec };
    },
    async byToken(token) {
      if (!token) return null;
      const r = (await q('SELECT p.id,p.name,p.starter_ver FROM tokens t JOIN players p ON p.id=t.player_id WHERE t.token_hash=$1', [hashToken(token)]))[0];
      if (r && r.starter_ver < STARTER_VER) await grantStarter(r.id);
      return r || null;
    },
    async recover(code) {
      const r = (await q('SELECT id,name FROM players WHERE recovery_hash=$1', [hashCode(code)]))[0];
      if (!r) return null;
      const token = crypto.randomBytes(24).toString('hex');
      await q('INSERT INTO tokens(token_hash,player_id) VALUES($1,$2)', [hashToken(token), r.id]);
      return { id: r.id, name: r.name, token };
    },
    async newRecovery(pid) {
      const rec = newRecovery();
      await q('UPDATE players SET recovery_hash=$1 WHERE id=$2', [hashCode(rec), pid]);
      return rec;
    },
    async rename(pid, name) { await q('UPDATE players SET name=$1 WHERE id=$2', [String(name).slice(0, 16), pid]); },
    async listDecks(pid) { return (await q('SELECT name,data FROM decks WHERE player_id=$1 ORDER BY updated_at,name', [pid])).map(r => Object.assign(JSON.parse(r.data), { name: r.name })); },
    async putDeck(pid, name, deck) {
      const data = JSON.stringify({ chars: deck.chars, skills: deck.skills, ab: deck.ab });
      const ex = await q('SELECT 1 FROM decks WHERE player_id=$1 AND name=$2', [pid, name]);
      if (ex.length) await q('UPDATE decks SET data=$1,updated_at=now() WHERE player_id=$2 AND name=$3', [data, pid, name]);
      else await q('INSERT INTO decks(player_id,name,data) VALUES($1,$2,$3)', [pid, name, data]);
    },
    async deckCount(pid) { return +(await q('SELECT count(*) AS n FROM decks WHERE player_id=$1', [pid]))[0].n; },
    async hasDeck(pid, name) { return (await q('SELECT 1 FROM decks WHERE player_id=$1 AND name=$2', [pid, name])).length > 0; },
    async delDeck(pid, name) { await q('DELETE FROM decks WHERE player_id=$1 AND name=$2', [pid, name]); },
    gachaState: pid => withLock(pid, async () => { const s = G.tick(await gstate(pid)); await gsave(pid, s); return view(s, await invOf(pid)); }),
    gachaOpen: (pid, packId) => withLock(pid, async () => {
      const pack = G.packById(packId); if (!pack) return { error: 'パックが見つかりません' };
      const s = G.tick(await gstate(pid));
      if (s.energy < G.PACK_COST) { await gsave(pid, s); return { error: 'エナジーが足りません' }; }
      const inv = await invOf(pid), cards = G.roll(pack), add = {};
      if (s.energy >= G.E_CAP) s.t = Date.now();
      s.energy -= G.PACK_COST; s.pity++; s.opened++;
      cards.forEach(c => {
        const o = inv[c.kind === 'char' ? 'chars' : 'skills'];
        c.isNew = !(o[c.key] || 0) && !add[c.kind + '|' + c.key];
        add[c.kind + '|' + c.key] = (add[c.kind + '|' + c.key] || 0) + 1;
      });
      for (const [id, n] of Object.entries(add)) {
        const [kind, key] = [id.slice(0, id.indexOf('|')), id.slice(id.indexOf('|') + 1)], o = inv[kind === 'char' ? 'chars' : 'skills'], had = o[key] || 0;
        o[key] = had + n; await setQty(pid, kind, key, had + n, had > 0);
      }
      await gsave(pid, s);
      return { cards, state: view(s, inv) };
    }),
    gachaConvert: pid => withLock(pid, async () => {
      const s = G.tick(await gstate(pid)), inv = await invOf(pid), x = G.excess(inv);
      if (!x.count) return { error: '変換できる余りがありません' };
      for (const e of x.list) { const o = inv[e.kind === 'char' ? 'chars' : 'skills'], had = o[e.key]; o[e.key] = had - e.n; await setQty(pid, e.kind, e.key, had - e.n, true); }
      s.energy += x.total; await gsave(pid, s);
      return { gained: x.total, count: x.count, state: view(s, inv) };
    }),
    gachaExchange: (pid, kind, key) => withLock(pid, async () => {
      if (kind !== 'char' && kind !== 'skill') return { error: '不正なカードです' };
      if (!(kind === 'char' ? key in catalog.chars : key in catalog.skills)) return { error: '不明なカードです' };
      const s = G.tick(await gstate(pid));
      if (s.pity < G.PITY_N) return { error: '天井まで足りません' };
      const inv = await invOf(pid), o = inv[kind === 'char' ? 'chars' : 'skills'], had = o[key] || 0;
      o[key] = had + 1; await setQty(pid, kind, key, had + 1, had > 0);
      s.pity -= G.PITY_N; await gsave(pid, s);
      return { state: view(s, inv) };
    }),
    async inventory(pid) {
      const o = { chars: {}, skills: {} };
      (await q('SELECT kind,key,qty FROM inventory WHERE player_id=$1', [pid])).forEach(r => { o[r.kind === 'char' ? 'chars' : 'skills'][r.key] = r.qty; });
      return o;
    },
  };
}
module.exports = { open, catalog, MIGRATIONS };
