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
  // 今後の変更(ガチャ履歴など)は、ここに配列を足していく。既存の配列は絶対に書き換えない。
];
const STARTER_VER = 1; // 基本カードを増やしたときに上げる(足りない分だけ配られる)

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
    const rows = [];
    for (const [k, n] of Object.entries(catalog.chars)) rows.push(['char', k, n]);
    for (const [k, n] of Object.entries(catalog.skills)) rows.push(['skill', k, n]);
    const have = new Set((await q('SELECT kind,key FROM inventory WHERE player_id=$1', [pid])).map(r => r.kind + '|' + r.key));
    for (const [kind, key, qty] of rows) {
      if (!have.has(kind + '|' + key)) await q('INSERT INTO inventory(player_id,kind,key,qty) VALUES($1,$2,$3,$4)', [pid, kind, key, qty]);
    }
    await q('UPDATE players SET starter_ver=$1 WHERE id=$2', [STARTER_VER, pid]);
  }

  return {
    kind,
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
    async inventory(pid) {
      const o = { chars: {}, skills: {} };
      (await q('SELECT kind,key,qty FROM inventory WHERE player_id=$1', [pid])).forEach(r => { o[r.kind === 'char' ? 'chars' : 'skills'][r.key] = r.qty; });
      return o;
    },
  };
}
module.exports = { open, catalog, MIGRATIONS };
