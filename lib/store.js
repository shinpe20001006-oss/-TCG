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
  // v3: 登録ボーナス(スターター+10枚)を配った印
  [
    `CREATE TABLE IF NOT EXISTS bonus(player_id TEXT PRIMARY KEY)`,
  ],
  // v4: 対戦報酬の1日ごとの回数
  [
    `CREATE TABLE IF NOT EXISTS reward(
       player_id TEXT NOT NULL, day TEXT NOT NULL, cpu INTEGER NOT NULL DEFAULT 0, pvp INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY(player_id, day))`,
  ],
  // v5: お知らせの既読・配布の受け取り済み
  [
    `CREATE TABLE IF NOT EXISTS news(
       player_id TEXT NOT NULL, news_id TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, is_claimed INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY(player_id, news_id))`,
  ],
  // v6: フレンド(コード・承認制)と対戦の招待
  [
    `CREATE TABLE IF NOT EXISTS profile(player_id TEXT PRIMARY KEY, friend_code TEXT NOT NULL UNIQUE)`,
    `CREATE TABLE IF NOT EXISTS friends(player_id TEXT NOT NULL, friend_id TEXT NOT NULL, PRIMARY KEY(player_id, friend_id))`,
    `CREATE TABLE IF NOT EXISTS friend_req(from_id TEXT NOT NULL, to_id TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(from_id, to_id))`,
    `CREATE TABLE IF NOT EXISTS invites(
       id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, room TEXT NOT NULL,
       status TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)`,
  ],
  // 今後の変更は、ここに配列を足していく。既存の配列は絶対に書き換えない。
];
const STARTER_VER = 2; // v2: ガチャ導入。この版より古いアカウントは1回だけ「スターターのみ」にリセット。※むやみに上げない(上げると全員のカードが再度リセットされる)
const G = require('./gacha');

// お知らせ(lib/news.json)。配布(grant)は {energy?:数, chars?:{キー:枚数}, skills:{'cond.enter':枚数}} の形
function loadNews() {
  const raw = require(process.env.NEWS_FILE || './news.json'), seen = new Set(), out = [];
  for (const n of raw) {
    if (!n || typeof n.id !== 'string' || !n.id || seen.has(n.id)) throw new Error('news.json: idが不正または重複しています: ' + (n && n.id));
    seen.add(n.id);
    const item = { id: n.id, date: String(n.date || ''), title: String(n.title || ''), body: String(n.body || '') };
    if (n.grant) {
      const g = { energy: 0, chars: {}, skills: {} };
      if (n.grant.energy) { if (!Number.isInteger(n.grant.energy) || n.grant.energy < 1 || n.grant.energy > 1000) throw new Error('news.json: energyが不正: ' + n.id); g.energy = n.grant.energy; }
      for (const [k, q] of Object.entries(n.grant.chars || {})) { if (!(k in catalog.chars) || !Number.isInteger(q) || q < 1 || q > 10) throw new Error('news.json: 不明なキャラ/枚数: ' + n.id + ' ' + k); g.chars[k] = q; }
      for (const [k, q] of Object.entries(n.grant.skills || {})) { if (!(k in catalog.skills) || !Number.isInteger(q) || q < 1 || q > 10) throw new Error('news.json: 不明なスキル/枚数: ' + n.id + ' ' + k); g.skills[k] = q; }
      if (g.energy || Object.keys(g.chars).length || Object.keys(g.skills).length) item.grant = g;
    }
    out.push(item);
  }
  return out;
}
const NEWS = loadNews();

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

  // 削除されたカード(G.RETIRED)を、全員の所持・デッキから外し、レア相当のエナジーで返す(何度走っても同じ結果)
  async function retireCards() {
  for (const [key, val] of Object.entries(G.RETIRED)) {
    for (const r of await q("SELECT player_id,qty FROM inventory WHERE kind='char' AND key=$1", [key])) {
      await q('UPDATE gacha SET energy=energy+$1 WHERE player_id=$2', [val * r.qty, r.player_id]);
      await q("DELETE FROM inventory WHERE player_id=$1 AND kind='char' AND key=$2", [r.player_id, key]);
    }
    for (const r of await q('SELECT player_id,name,data FROM decks WHERE data LIKE $1', ['%"' + key + '"%'])) {
      const d = JSON.parse(r.data); if (d.chars) delete d.chars[key];
      await q('UPDATE decks SET data=$1 WHERE player_id=$2 AND name=$3', [JSON.stringify(d), r.player_id, r.name]);
    }
  }
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
    await q('DELETE FROM bonus WHERE player_id=$1', [pid]);
    await grantBonus(pid);
  }
  async function grantBonus(pid) {
    const inv = await invOf(pid);
    for (const c of G.bonus(inv)) { const o = inv[c.kind === 'char' ? 'chars' : 'skills'], had = o[c.key] || 0; o[c.key] = had + 1; await setQty(pid, c.kind, c.key, had + 1, had > 0); }
    await q('INSERT INTO bonus(player_id) VALUES($1)', [pid]);
  }
  // 同じプレイヤーのガチャ操作は1つずつ順番に(連打・二重送信での不正を防ぐ)
  const MAX_FRIENDS = 50;
  const pnameOf = async id => { const r = await q('SELECT name FROM players WHERE id=$1', [id]); return r.length ? r[0].name : '(不明)'; };
  const pidByCode = async raw => {
    const c = normCode(raw); if (c.length !== 8) return null;
    const r = await q('SELECT player_id FROM profile WHERE friend_code=$1', [c.slice(0, 4) + '-' + c.slice(4)]);
    return r.length ? r[0].player_id : null;
  };
  const fcount = async id => +(await q('SELECT COUNT(*) AS n FROM friends WHERE player_id=$1', [id]))[0].n;
  async function makeFriends(a, b) {
    for (const [x, y] of [[a, b], [b, a]]) { try { await q('INSERT INTO friends(player_id,friend_id) VALUES($1,$2)', [x, y]); } catch (e) {} }
    await q('DELETE FROM friend_req WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)', [a, b]);
  }
  const locks = new Map(), bonusDone = new Set();
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
  async function rewardRow(pid) {
    const day = G.dayKey();
    const r = (await q('SELECT cpu,pvp FROM reward WHERE player_id=$1 AND day=$2', [pid, day]))[0];
    return { day, cpu: r ? +r.cpu : 0, pvp: r ? +r.pvp : 0, has: !!r };
  }
  async function rewardInfo(pid) { const r = await rewardRow(pid); return { cpu: r.cpu, pvp: r.pvp, cpuMax: G.REWARD.cpuMax, pvpMax: G.REWARD.pvpMax }; }
  // kind: 'cpu' | 'pvp'。上限に達していれば 0 を返す(エナジーは足さない)
  async function rewardApply(pid, kind, amount) {
    const r = await rewardRow(pid), max = kind === 'cpu' ? G.REWARD.cpuMax : G.REWARD.pvpMax;
    if (r[kind] >= max) return 0;
    if (r.has) await q(`UPDATE reward SET ${kind}=${kind}+1 WHERE player_id=$1 AND day=$2`, [pid, r.day]);
    else await q(`INSERT INTO reward(player_id,day,cpu,pvp) VALUES($1,$2,$3,$4)`, [pid, r.day, kind === 'cpu' ? 1 : 0, kind === 'pvp' ? 1 : 0]);
    const s = G.tick(await gstate(pid)); s.energy += amount; await gsave(pid, s);
    return amount;
  }
  // 対人戦: 同じ対戦(match)について、別々のアカウントから「勝ち」と「負け」が1つずつ届いたときだけ両者に配る
  const pending = new Map(), granted = new Map();
  const sweep = () => { const t = Date.now() - 30 * 60e3; for (const [k, v] of pending) if (v.t < t) pending.delete(k); for (const [k, v] of granted) if (v.t < t) granted.delete(k); };
  const pvpAmount = res => res === 'win' ? G.REWARD.pvpWin : G.REWARD.pvpLose;
  const gsave = (pid, s) => q('UPDATE gacha SET energy=$1,energy_t=$2,pity=$3,opened=$4 WHERE player_id=$5', [s.energy, s.t, s.pity, s.opened, pid]);
  const view = (s, inv) => ({ energy: s.energy, nextMs: G.nextMs(s), pity: s.pity, opened: s.opened, cap: G.E_CAP, cost: G.PACK_COST, pityN: G.PITY_N, inv });

  await retireCards();
  return {
    kind,
    retireCards,
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
      if (r && r.starter_ver < STARTER_VER) {
        await withLock(r.id, async () => { // 同時アクセスでも1回だけリセット
          const cur = (await q('SELECT starter_ver FROM players WHERE id=$1', [r.id]))[0];
          if (cur && cur.starter_ver < STARTER_VER) await grantStarter(r.id);
        });
      }
      if (r && !bonusDone.has(r.id)) { // v2まで作られたアカウントにも、登録ボーナスを1回だけ配る
        await withLock(r.id, async () => { if (!(await q('SELECT 1 FROM bonus WHERE player_id=$1', [r.id])).length) await grantBonus(r.id); });
        bonusDone.add(r.id); if (bonusDone.size > 20000) bonusDone.clear();
      }
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
    gachaState: pid => withLock(pid, async () => { const s = G.tick(await gstate(pid)); await gsave(pid, s); return Object.assign(view(s, await invOf(pid)), { reward: await rewardInfo(pid) }); }),
    rewardCpu: pid => withLock(pid, async () => {
      const gained = await rewardApply(pid, 'cpu', G.REWARD.cpuWin);
      const s = G.tick(await gstate(pid)); await gsave(pid, s);
      return { status: gained ? 'granted' : 'capped', gained, state: Object.assign(view(s, await invOf(pid)), { reward: await rewardInfo(pid) }) };
    }),
    async rewardPvp(pid, match, result) {
      if (typeof match !== 'string' || !match || match.length > 80 || (result !== 'win' && result !== 'lose')) return { status: 'rejected' };
      sweep();
      const gk = match + '|' + pid;
      const stateOf = async gained => withLock(pid, async () => { const s = G.tick(await gstate(pid)); await gsave(pid, s); return Object.assign(view(s, await invOf(pid)), { reward: await rewardInfo(pid) }); });
      const done = granted.get(gk);
      if (done) return { status: done.gained ? 'granted' : 'capped', gained: done.gained, state: await stateOf() };
      const p = pending.get(match);
      if (!p) { pending.set(match, { t: Date.now(), reports: { [pid]: result } }); return { status: 'pending' }; }
      if (p.reports[pid]) return { status: 'pending' };
      const [otherPid, otherRes] = Object.entries(p.reports)[0];
      if (otherRes === result) { pending.delete(match); return { status: 'rejected' }; } // 勝ち同士・負け同士は不一致
      pending.delete(match);
      for (const [id, res] of [[pid, result], [otherPid, otherRes]]) {
        const gained = await withLock(id, () => rewardApply(id, 'pvp', pvpAmount(res)));
        granted.set(match + '|' + id, { t: Date.now(), gained });
      }
      const mine = granted.get(gk);
      return { status: mine.gained ? 'granted' : 'capped', gained: mine.gained, state: await stateOf() };
    },
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
      if (!Object.prototype.hasOwnProperty.call(kind === 'char' ? catalog.chars : catalog.skills, key)) return { error: '不明なカードです' };
      if (!G.isReleased(kind, key)) return { error: 'まだ発売されていないカードです' };
      const s = G.tick(await gstate(pid));
      if (s.pity < G.PITY_N) return { error: '天井まで足りません' };
      const inv = await invOf(pid), o = inv[kind === 'char' ? 'chars' : 'skills'], had = o[key] || 0;
      o[key] = had + 1; await setQty(pid, kind, key, had + 1, had > 0);
      s.pity -= G.PITY_N; await gsave(pid, s);
      return { state: view(s, inv) };
    }),
    // ---- フレンド・招待 ----
    async friendCode(pid) {
      const r = await q('SELECT friend_code FROM profile WHERE player_id=$1', [pid]);
      if (r.length) return r[0].friend_code;
      for (let i = 0; i < 30; i++) {
        const c = randCode(8), f = c.slice(0, 4) + '-' + c.slice(4);
        try { await q('INSERT INTO profile(player_id,friend_code) VALUES($1,$2)', [pid, f]); return f; }
        catch (e) { const r2 = await q('SELECT friend_code FROM profile WHERE player_id=$1', [pid]); if (r2.length) return r2[0].friend_code; }
      }
      throw new Error('フレンドコードを作れませんでした');
    },
    async friendsView(pid) {
      const code = await this.friendCode(pid);
      const friends = [], sent = [];
      for (const r of await q('SELECT friend_id FROM friends WHERE player_id=$1', [pid])) friends.push({ code: await this.friendCode(r.friend_id), name: await pnameOf(r.friend_id) });
      for (const r of await q('SELECT to_id FROM friend_req WHERE from_id=$1 ORDER BY created_at', [pid])) sent.push({ code: await this.friendCode(r.to_id), name: await pnameOf(r.to_id) });
      friends.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
      return { code, friends, sent };
    },
    friendRequest: (pid, raw) => withLock(pid, async () => {
      const to = await pidByCode(raw); if (!to) return { error: 'そのフレンドコードは見つかりません' };
      if (to === pid) return { error: '自分自身には申請できません' };
      if ((await q('SELECT 1 FROM friends WHERE player_id=$1 AND friend_id=$2', [pid, to])).length) return { error: 'すでにフレンドです' };
      if ((await q('SELECT 1 FROM friend_req WHERE from_id=$1 AND to_id=$2', [pid, to])).length) return { error: 'すでに申請しています' };
      if (await fcount(pid) >= MAX_FRIENDS) return { error: 'フレンドは' + MAX_FRIENDS + '人までです' };
      if ((await q('SELECT 1 FROM friend_req WHERE from_id=$1 AND to_id=$2', [to, pid])).length) { // 相手からも申請が来ていれば、その場で成立
        if (await fcount(to) >= MAX_FRIENDS) return { error: '相手のフレンドが上限です' };
        await makeFriends(pid, to); return { ok: true, status: 'accepted', name: await pnameOf(to) };
      }
      if (await q('SELECT COUNT(*) AS n FROM friend_req WHERE from_id=$1', [pid]).then(r => +r[0].n >= 30)) return { error: '申請中が多すぎます(30件まで)' };
      await q('INSERT INTO friend_req(from_id,to_id,created_at) VALUES($1,$2,$3)', [pid, to, Date.now()]);
      return { ok: true, status: 'sent', name: await pnameOf(to) };
    }),
    friendAccept: (pid, raw) => withLock(pid, async () => {
      const from = await pidByCode(raw);
      if (!from || !(await q('SELECT 1 FROM friend_req WHERE from_id=$1 AND to_id=$2', [from, pid])).length) return { error: '申請が見つかりません(取り消された可能性があります)' };
      if (await fcount(pid) >= MAX_FRIENDS) return { error: 'フレンドは' + MAX_FRIENDS + '人までです' };
      if (await fcount(from) >= MAX_FRIENDS) { await q('DELETE FROM friend_req WHERE from_id=$1 AND to_id=$2', [from, pid]); return { error: '相手のフレンドが上限のため、承認できませんでした' }; }
      await makeFriends(from, pid); return { ok: true };
    }),
    friendDecline: (pid, raw) => withLock(pid, async () => {
      const from = await pidByCode(raw); if (from) await q('DELETE FROM friend_req WHERE from_id=$1 AND to_id=$2', [from, pid]);
      return { ok: true };
    }),
    friendCancel: (pid, raw) => withLock(pid, async () => {
      const to = await pidByCode(raw); if (to) await q('DELETE FROM friend_req WHERE from_id=$1 AND to_id=$2', [pid, to]);
      return { ok: true };
    }),
    friendRemove: (pid, raw) => withLock(pid, async () => {
      const o = await pidByCode(raw);
      if (o) { await q('DELETE FROM friends WHERE player_id=$1 AND friend_id=$2', [pid, o]); await q('DELETE FROM friends WHERE player_id=$1 AND friend_id=$2', [o, pid]); }
      return { ok: true };
    }),
    // 受信箱: 届いたフレンド申請と、対戦の招待(終了したものは、1回見るまで残す)
    async inbox(pid, alive) {
      const requests = [], invites = [];
      for (const r of await q('SELECT from_id FROM friend_req WHERE to_id=$1 ORDER BY created_at', [pid])) requests.push({ code: await this.friendCode(r.from_id), name: await pnameOf(r.from_id) });
      const rows = await q("SELECT id,from_id,room,status,seen FROM invites WHERE to_id=$1 AND (status='open' OR (status='closed' AND seen=0)) ORDER BY created_at DESC", [pid]);
      for (const r of rows) {
        let status = r.status;
        if (status === 'open' && !(alive && alive(r.room))) { await q("UPDATE invites SET status='closed' WHERE id=$1", [r.id]); status = 'closed'; }
        invites.push({ id: r.id, name: await pnameOf(r.from_id), status });
      }
      return { requests, invites };
    },
    inboxSeen: pid => withLock(pid, async () => { await q("UPDATE invites SET seen=1 WHERE to_id=$1 AND status='closed'", [pid]); return { ok: true }; }),
    inviteSend: (pid, raw, room, alive) => withLock(pid, async () => {
      const to = await pidByCode(raw); room = String(room || '').toUpperCase();
      if (!to || !(await q('SELECT 1 FROM friends WHERE player_id=$1 AND friend_id=$2', [pid, to])).length) return { error: 'フレンドではありません' };
      if (!/^[A-Z]{5}$/.test(room) || !(alive && alive(room))) return { error: 'ルームが有効ではありません' };
      const last = await q('SELECT created_at FROM invites WHERE from_id=$1 AND to_id=$2 ORDER BY created_at DESC LIMIT 1', [pid, to]);
      if (last.length && Date.now() - Number(last[0].created_at) < 60e3) return { error: '同じフレンドへの招待は1分に1回までです' };
      await q("UPDATE invites SET status='closed', seen=1 WHERE from_id=$1 AND to_id=$2 AND status='open'", [pid, to]);
      await q('DELETE FROM invites WHERE created_at<$1', [Date.now() - 2 * 86400e3]);
      await q('INSERT INTO invites(id,from_id,to_id,room,status,seen,created_at) VALUES($1,$2,$3,$4,$5,0,$6)', [randCode(10), pid, to, room, 'open', Date.now()]);
      return { ok: true, name: await pnameOf(to) };
    }),
    inviteJoin: (pid, id, alive) => withLock(pid, async () => {
      const r = await q("SELECT room FROM invites WHERE id=$1 AND to_id=$2 AND status='open'", [id, pid]);
      if (!r.length) return { error: 'この招待は終了しました' };
      if (!(alive && alive(r[0].room))) { await q("UPDATE invites SET status='closed' WHERE id=$1", [id]); return { error: 'この招待は終了しました' }; }
      await q("UPDATE invites SET status='used' WHERE id=$1", [id]);
      return { ok: true, room: r[0].room };
    }),
    async closeInvitesByRoom(room) { await q("UPDATE invites SET status='closed' WHERE room=$1 AND status='open'", [String(room)]); },
    async newsList(pid) {
      const st = {};
      (await q('SELECT news_id,is_read,is_claimed FROM news WHERE player_id=$1', [pid])).forEach(r => { st[r.news_id] = r; });
      return NEWS.map(n => ({ ...n, read: !!(st[n.id] && st[n.id].is_read), claimed: !!(st[n.id] && st[n.id].is_claimed) }));
    },
    newsRead: (pid, id) => withLock(pid, async () => {
      if (!NEWS.some(n => n.id === id)) return { error: 'お知らせが見つかりません' };
      const r = await q('SELECT is_read FROM news WHERE player_id=$1 AND news_id=$2', [pid, id]);
      if (!r.length) await q('INSERT INTO news(player_id,news_id,is_read,is_claimed) VALUES($1,$2,1,0)', [pid, id]);
      else if (!r[0].is_read) await q('UPDATE news SET is_read=1 WHERE player_id=$1 AND news_id=$2', [pid, id]);
      return { ok: true };
    }),
    newsClaim: (pid, id) => withLock(pid, async () => {
      const n = NEWS.find(x => x.id === id);
      if (!n || !n.grant) return { error: '受け取れる配布がありません' };
      const r = await q('SELECT is_claimed FROM news WHERE player_id=$1 AND news_id=$2', [pid, id]);
      if (r.length && r[0].is_claimed) return { error: 'すでに受け取り済みです' };
      const inv = await invOf(pid);
      for (const [kind, map] of [['char', n.grant.chars], ['skill', n.grant.skills]]) {
        const o = inv[kind === 'char' ? 'chars' : 'skills'];
        for (const [k, q2] of Object.entries(map)) { const had = o[k] || 0; o[k] = had + q2; await setQty(pid, kind, k, had + q2, had > 0); }
      }
      if (n.grant.energy) { const s = G.tick(await gstate(pid)); s.energy += n.grant.energy; await gsave(pid, s); }
      if (!r.length) await q('INSERT INTO news(player_id,news_id,is_read,is_claimed) VALUES($1,$2,1,1)', [pid, id]);
      else await q('UPDATE news SET is_read=1,is_claimed=1 WHERE player_id=$1 AND news_id=$2', [pid, id]);
      return { ok: true, grant: n.grant };
    }),
    async inventory(pid) {

      const o = { chars: {}, skills: {} };
      (await q('SELECT kind,key,qty FROM inventory WHERE player_id=$1', [pid])).forEach(r => { o[r.kind === 'char' ? 'chars' : 'skills'][r.key] = r.qty; });
      return o;
    },
  };
}
module.exports = { open, catalog, MIGRATIONS, NEWS };
