// Demo snapshot: shape (same as the OLAP cube snapshot), referential integrity, data invariants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoSnapshot } from '../src/demo/snapshot.js';
import { buildDemoModel } from '../src/demo/model.js';
import { DEPTS_WL } from '../src/report/reportConfig.js';

const built = await buildDemoSnapshot();
const S = JSON.parse(built.json);

const SNAPSHOT_KEYS = [
  'gen', 'builtAt', 'scope', 'firstYM', 'lastYM', 'items', 'a6groups', 'tovgrps', 'stages', 'tgTops', 'kinds',
  'motivLowers', 'mlUpper', 'motivUppers', 'trademarks', 'subbrands', 'depts', 'deptParents', 'partners',
  'terr1', 'terr2', 'terr2Parent', 'partTerr1', 'partTerr2', 'rmgrs', 'tmgrs', 'partRmgr', 'partTmgr',
  'sales', 'defect', 'stock', 'prod', 'plan', 'forecast', 'forecastInfo', 'stratPlan', 'stratInfo',
  'basePrices', 'basePriceInfo',
];
const META_KEYS = ['gen', 'scope', 'firstYM', 'lastYM', 'items', 'depts', 'partners', 'sales', 'defect', 'stock', 'prod', 'plan', 'forecast', 'forecastQty'];
const ITEM_KEYS = ['n', 'b', 'c', 'g', 'sb', 'tg', 'st', 'tgt', 'vk', 'ml', 'mu', 'tm'];
const inRange = (v, arr) => Number.isInteger(v) && v >= 0 && v < arr.length;
const prev3 = ym => [1, 2, 3].map(k => {
  const t = Math.floor(ym / 100) * 12 + (ym % 100) - 1 - k;
  return Math.floor(t / 12) * 100 + (t % 12) + 1;
});
const days = ym => new Date(Math.floor(ym / 100), ym % 100, 0).getDate();

test('buildSnapshot returns { json, meta, forecast, forecastInfo } with the original key sets', () => {
  assert.deepEqual(Object.keys(built).sort(), ['forecast', 'forecastInfo', 'json', 'meta']);
  assert.deepEqual(Object.keys(S), SNAPSHOT_KEYS);
  assert.deepEqual(Object.keys(built.meta), META_KEYS);
  assert.deepEqual(built.forecast, S.forecast);
  assert.deepEqual(built.forecastInfo, S.forecastInfo);
  for (const it of S.items) assert.deepEqual(Object.keys(it), ITEM_KEYS);
});

test('history Jan 2024 → Oct 2026, scale within targets', () => {
  assert.equal(S.firstYM, 202401);
  assert.equal(S.lastYM, 202610);
  assert.equal(S.lastYM, Math.max(...S.stock.map(r => r[1])));
  assert.ok(S.items.length >= 400 && S.items.length <= 600, `items=${S.items.length}`);
  assert.ok(S.partners.length >= 250 && S.partners.length <= 400, `partners=${S.partners.length}`);
  assert.deepEqual([...S.depts].sort(), [...DEPTS_WL].sort());
  assert.ok(built.json.length <= 15e6, `json=${built.json.length}`);
});

test('tuple layouts and ids are in range of their registries', () => {
  for (const r of S.sales) {
    assert.equal(r.length, 6);
    assert.ok(inRange(r[0], S.items) && inRange(r[1], S.depts) && inRange(r[2], S.partners));
    assert.ok(r[3] >= S.firstYM && r[3] <= S.lastYM && r[5] > 0);
  }
  for (const r of S.defect) {
    assert.equal(r.length, 8);
    assert.ok(inRange(r[0], S.items) && inRange(r[1], S.depts) && inRange(r[2], S.partners));
    assert.ok(r[6] <= r[4] && r[6] >= 0, 'de-duplicated unfulfilled demand does not exceed the raw value');
  }
  for (const r of S.stock) assert.ok(r.length === 4 && inRange(r[0], S.items) && r[3] <= r[2]);
  for (const r of S.prod) assert.ok(r.length === 5 && inRange(r[0], S.items));
  for (const r of S.plan) {
    assert.equal(r.length, 6);
    assert.ok(inRange(r[0], S.depts) && inRange(r[1], S.partners) && inRange(r[2], S.a6groups));
  }
  for (const r of S.forecast) assert.ok(r.length === 3 && inRange(r[0], S.items) && r[2] > 0);
  for (const r of S.stratPlan) assert.ok(r.length === 4 && inRange(r[0], S.depts) && inRange(r[1], S.motivLowers));
  for (const it of S.items) {
    assert.ok(it.g === -1 || inRange(it.g, S.a6groups));
    for (const [k, arr] of [['sb', S.subbrands], ['tg', S.tovgrps], ['st', S.stages], ['tgt', S.tgTops], ['vk', S.kinds], ['ml', S.motivLowers], ['mu', S.motivUppers], ['tm', S.trademarks]]) {
      assert.ok(inRange(it[k], arr), `${it.n}: ${k}`);
    }
  }
});

test('partner-aligned and registry-aligned arrays', () => {
  for (const k of ['partTerr1', 'partTerr2', 'partRmgr', 'partTmgr']) assert.equal(S[k].length, S.partners.length, k);
  S.partTerr1.forEach(v => assert.ok(inRange(v, S.terr1)));
  S.partTerr2.forEach(v => assert.ok(inRange(v, S.terr2)));
  S.partRmgr.forEach(v => assert.ok(inRange(v, S.rmgrs)));
  S.partTmgr.forEach(v => assert.ok(inRange(v, S.tmgrs)));
  assert.equal(S.terr2Parent.length, S.terr2.length);
  S.terr2Parent.forEach(v => assert.ok(inRange(v, S.terr1)));
  assert.equal(S.deptParents.length, S.depts.length);
  assert.equal(S.mlUpper.length, S.motivLowers.length);
  assert.equal(S.basePrices.length, S.items.length);
});

test('every stock zone (<15, 15–30, 30–90, 90–180, >180 days) is populated', () => {
  // same formula as the dashboard: last stock ÷ (sales over the 3 months before lastYM ÷ days)
  const rm = prev3(S.lastYM);
  const rd = rm.reduce((s, k) => s + days(k), 0);
  const q = new Map();
  for (const r of S.sales) if (rm.includes(r[3])) q.set(r[0], (q.get(r[0]) || 0) + r[5]);
  const last = new Map();
  for (const r of S.stock) if (!last.has(r[0]) || r[1] > last.get(r[0])[1]) last.set(r[0], r);
  const zones = new Map();
  for (const [it, r] of last) {
    const rate = (q.get(it) || 0) / rd;
    if (!rate) continue;
    const d = r[2] / rate;
    const z = d < 15 ? 's1' : d < 30 ? 's2' : d <= 90 ? 's3' : d <= 180 ? 's4' : 's5';
    zones.set(z, (zones.get(z) || 0) + 1);
  }
  for (const z of ['s1', 's2', 's3', 's4', 's5']) assert.ok(zones.get(z) >= 10, `zone ${z}: ${zones.get(z) || 0}`);
});

test('year-over-year data exists and is plausible', () => {
  const byYm = new Map();
  for (const r of S.sales) byYm.set(r[3], (byYm.get(r[3]) || 0) + r[4]);
  for (let m = 1; m <= 12; m++) assert.ok(byYm.get(202400 + m) > 0 && byYm.get(202500 + m) > 0, `month ${m}`);
  let cur = 0, py = 0;
  for (let m = 1; m <= 10; m++) {
    cur += byYm.get(202600 + m);
    py += byYm.get(202500 + m);
  }
  const yoy = cur / py - 1;
  assert.ok(yoy > -0.1 && yoy < 0.3, `YoY ${yoy}`);
});

test('defects are a few percent with dedup below fact; novelties, plan and forecast present', () => {
  const rub = S.sales.reduce((s, r) => s + r[4], 0);
  const def = S.defect.reduce((s, r) => s + r[5], 0);
  const dedup = S.defect.reduce((s, r) => s + r[7], 0);
  assert.ok(def / rub > 0.01 && def / rub < 0.08, `defect share ${def / rub}`);
  assert.ok(dedup < def);
  const first = new Map();
  for (const r of S.sales) if (!first.has(r[0]) || r[3] < first.get(r[0])) first.set(r[0], r[3]);
  const years = new Set([...first.values()].map(ym => Math.floor(ym / 100)));
  assert.ok(years.has(2025) && years.has(2026), 'new products launched in 2025 and 2026');
  // part of the plan maps exactly to product groups, part goes to the technical group (fallback allocation)
  const itemGroups = new Set(S.items.map(i => i.g).filter(g => g >= 0));
  assert.ok(S.plan.some(r => itemGroups.has(r[2])));
  assert.ok(S.plan.some(r => !itemGroups.has(r[2])));
  assert.ok(S.forecastInfo.ok && S.forecastInfo.months.length === 12 && S.forecast.length > 0);
  assert.ok(S.stratInfo.ok && S.stratInfo.unmatchedDepts.length > 0);
  assert.ok(S.basePriceInfo.ok && S.basePriceInfo.withPrice > S.items.length * 0.9);
});

test('generator is deterministic (two independent builds are identical)', () => {
  const facts = M => JSON.stringify([M.items, M.partners, M.sales, M.defect, [...M.dayMax], M.stock, M.prod, M.planRows, M.forecast, M.strat]);
  assert.equal(facts(buildDemoModel()), facts(buildDemoModel()));
  assert.notEqual(facts(buildDemoModel({ seed: 7 })), facts(buildDemoModel()), 'a different seed yields different data');
});

test('no real company names in demo data', () => {
  const banned = /Магнит|X5|Пят[её]рочка|Перекр[её]сток|Лента|Ашан|Auchan|Ozon|Озон|Wildberries|Вайлдберриз|Яндекс|Сбер|Metro|Метро|Леруа|Детский мир|Fix ?Price|Светофор|Магнолия|Монетка|Дикси|Улыбка радуги|Золотое яблоко|Л[ье]Этуаль|Подружка/i;
  const found = built.json.match(banned);
  assert.equal(found, null, `found: ${found?.[0]}`);
});
