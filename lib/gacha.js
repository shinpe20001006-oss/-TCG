'use strict';
/* サーバー側のガチャ判定。抽選・エナジー・変換・天井はすべてここで行う(クライアントは結果を表示するだけ)。 */
const crypto = require('crypto');
const catalog = require('./catalog.json');
const E_MS = 10 * 60 * 1000, E_CAP = 300, E_START = 100, PACK_COST = 50, PITY_N = 100;
// 対戦報酬(エナジー)。CPU戦は勝ったときだけ。対人戦は両者が結果を報告した対戦だけ。1日(日本時間0時で切替)の上限あり
const REWARD = { cpuWin: 5, cpuMax: 10, pvpWin: 10, pvpLose: 5, pvpMax: 10 };
const dayKey = (now) => new Date((now || Date.now()) + 9 * 3600e3).toISOString().slice(0, 10);
const RVAL = { 1: 1, 2: 3, 3: 10 };
// 削除したカード: 所持分はレア相当のエナジー(レア3=10)で返す。カードを消すときはここに追加する
const RETIRED = { colossus: 10 };
const SKILL_IDS = Object.keys(catalog.skills);
const CHAR_KEYS = Object.keys(catalog.chars);
const R1 = CHAR_KEYS.filter(k => catalog.rar[k] === 1);

const rnd = () => crypto.randomInt(0, 1e9) / 1e9;
const pick = a => a[Math.floor(rnd() * a.length)];

function tick(s, now) {
  now = now || Date.now();
  if (s.energy >= E_CAP) { s.t = now; return s; }
  const n = Math.floor((now - s.t) / E_MS);
  if (n > 0) { s.energy = Math.min(E_CAP, s.energy + n); s.t = s.energy >= E_CAP ? now : s.t + n * E_MS; }
  return s;
}
const nextMs = (s, now) => s.energy >= E_CAP ? 0 : Math.max(0, E_MS - ((now || Date.now()) - s.t));
// open=いま引けるパック / live=発売済み(その弾のレア3は天井交換・登録ボーナスの対象になる)
const packById = id => catalog.packs.find(p => p.id === id && p.open);
const RELEASED_R3 = new Set(); catalog.packs.filter(p => p.live).forEach(p => { p.r3.forEach(k => RELEASED_R3.add(k)); p.r2.forEach(k => RELEASED_R3.add(k)); RELEASED_R3.add(p.feature); });
// 発売済み: レア1は常に。レア2・3は、発売中(live)のパックに入っているカードだけ(閉じているパックの新カードは、天井交換できない)
const isReleased = (kind, key) => kind !== 'char' || !(catalog.rar[key] >= 2) || RELEASED_R3.has(key);

function roll(pack) {
  const r2 = pack.r2, r3 = pack.r3.concat([pack.feature]);
  const char = (p2, p3) => {
    const x = rnd();
    if (x < p3) {
      const w = r3.map(k => k === pack.feature ? pack.featW : 1), tot = w.reduce((a, b) => a + b, 0);
      let y = rnd() * tot;
      for (let i = 0; i < r3.length; i++) { y -= w[i]; if (y <= 0) return { kind: 'char', key: r3[i], rarity: 3 }; }
      return { kind: 'char', key: r3[r3.length - 1], rarity: 3 };
    }
    if (x < p3 + p2) return { kind: 'char', key: pick(r2), rarity: 2 };
    return { kind: 'char', key: pick(R1), rarity: 1 };
  };
  const out = [];
  for (let i = 0; i < 10; i++) out.push(rnd() < 0.4 ? char(0.28, 0.02) : { kind: 'skill', key: pick(SKILL_IDS), rarity: 0 });
  out.push(char(0.40, 0.06));
  return out;
}
const capOf = (kind, key) => kind === 'char' ? catalog.chars[key] : 3;
const valOf = (kind, key) => kind === 'char' ? RVAL[catalog.rar[key]] : 1;
function excess(inv) {
  const list = []; let total = 0;
  for (const [k, n] of Object.entries(inv.chars)) { if (!(k in catalog.chars)) continue; const e = n - (catalog.chars[k] || 0); if (e > 0) list.push({ kind: 'char', key: k, n: e }); }
  for (const [k, n] of Object.entries(inv.skills)) { if (!(k in catalog.skills)) continue; const e = n - 3; if (e > 0) list.push({ kind: 'skill', key: k, n: e }); }
  list.forEach(x => { total += x.n * valOf(x.kind, x.key); });
  return { list, total, count: list.reduce((a, x) => a + x.n, 0) };
}
/* 登録ボーナス: スターターに加えて10枚(レア3を1枚、レア2を2枚、レア1を2枚、スキルを5枚)。上限枚数は超えない */
function bonus(inv) {
  const out = [], add = {};
  const have = (kind, k) => (inv[kind === 'char' ? 'chars' : 'skills'][k] || 0) + (add[kind + '|' + k] || 0);
  const take = (kind, list, n) => {
    for (let i = 0, g = 0; i < n && g++ < 200;) {
      const k = pick(list);
      if (have(kind, k) >= capOf(kind, k)) continue;
      add[kind + '|' + k] = (add[kind + '|' + k] || 0) + 1; out.push({ kind, key: k, rarity: kind === 'char' ? catalog.rar[k] : 0 }); i++;
    }
  };
  take('char', CHAR_KEYS.filter(k => catalog.rar[k] === 3 && RELEASED_R3.has(k)), 1);
  take('char', CHAR_KEYS.filter(k => catalog.rar[k] === 2 && RELEASED_R3.has(k)), 2);
  take('char', R1, 2);
  take('skill', SKILL_IDS, 5);
  return out;
}
module.exports = { REWARD, dayKey, isReleased, RETIRED, bonus, E_MS, E_CAP, E_START, PACK_COST, PITY_N, tick, nextMs, packById, roll, excess, capOf, catalog };
