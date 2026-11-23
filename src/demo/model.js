// Demo business model of the fictional cosmetics manufacturer NORD — a deterministic generator.
//
// The model holds "raw" domain facts (products, clients and departments by name, fact rows by model
// index). Both the dashboard snapshot (demo/snapshot.js) and the "Client agent" API responses
// (demo/customerService.js, demo/clientStock.js) are built from it, so figures agree across tabs.
// One seed → the same data on every run.
//
// What is built in so the dashboard has something to show:
//   - history from January of FIRST_YEAR to lastYM, seasonality by product type, brand and client trends;
//   - new products (2025–2026 launches with a sales ramp-up) and product phase-outs;
//   - shortage episodes (background noise and brand-level spikes) → unfulfilled demand with repeat orders;
//   - stock in every cover zone (<15, 15–30, 30–90, 90–180, >180 days), dead stock for phased-out items;
//   - production, operational plan by client, strategic plan, analytical forecast, prices.
import { rng, hash32 } from './random.js';
import * as C from './catalog.js';
import { DEPTS_WL, FIRST_YEAR, PLAN_YEAR, FC_YEAR } from '../report/reportConfig.js';
import { NA, cleanGroup, skName, skUpper } from '../report/snapshotCore.js';

export const DEMO_SEED = 20261;
export const DEMO_LAST_YM = Number(process.env.DEMO_LAST_YM) || 202610;

// ——— calendar ———
export const ymAdd = (ym, k) => {
  const t = Math.floor(ym / 100) * 12 + (ym % 100) - 1 + k;
  return Math.floor(t / 12) * 100 + (t % 12) + 1;
};
export const ymDiff = (a, b) => (Math.floor(a / 100) - Math.floor(b / 100)) * 12 + (a % 100) - (b % 100);
export const daysIn = ym => new Date(Math.floor(ym / 100), ym % 100, 0).getDate();
const monthsBetween = (from, to) => {
  const out = [];
  for (let ym = from; ym <= to; ym = ymAdd(ym, 1)) out.push(ym);
  return out;
};
// Market-wide calendar effect: January dip, holiday December.
const CAL = [0.86, 0.96, 1.06, 1.0, 1.0, 0.97, 0.96, 0.99, 1.03, 1.04, 1.02, 1.08];
const round3 = v => Math.round(v / 1000) * 1000;

// ——— stock cover zones for the last month: share of products and day range ———
const STOCK_REGIMES = [
  { p: 0.11, d: [3, 14] },
  { p: 0.14, d: [16, 29] },
  { p: 0.47, d: [32, 85] },
  { p: 0.16, d: [95, 165] },
  { p: 0.12, d: [190, 300] },
];

// ——— client channels: which brands they buy and how often ———
// fit[product channel] — interest weight; budget — budget brands only (private label, discounters).
const BUDGET = new Set(['КОРОЛЕВНА', 'ГАММА', 'COLORIA', 'AQUABERRY', 'ГОРКИ', 'МЕГАДРАКОНЫ']);
const KINDS = {
  key: { fit: { retail: 1, kids: 0.8, derma: 0.25 }, freq: 0.92, assort: [160, 220], disc: [0.18, 0.26], cls: 'Ключевая сеть' },
  keyKids: { fit: { kids: 1.6, retail: 0.12, derma: 0.3 }, freq: 0.92, assort: [80, 100], disc: [0.18, 0.24], cls: 'Ключевая сеть' },
  market: { fit: { retail: 1, kids: 0.9, derma: 0.8, prof: 0.25 }, freq: 0.95, assort: [190, 250], disc: [0.12, 0.2], cls: 'Маркетплейс' },
  ecom: { fit: { retail: 1, kids: 0.5, derma: 0.9 }, freq: 0.8, assort: [45, 80], disc: [0.08, 0.14], cls: 'Интернет-магазин' },
  chain: { fit: { retail: 1, kids: 0.7, derma: 0.15 }, freq: 0.85, assort: [55, 95], disc: [0.12, 0.18], cls: 'Региональная сеть' },
  distr: { fit: { retail: 1, kids: 0.8, derma: 0.2 }, freq: 0.85, assort: [55, 85], disc: [0.2, 0.28], cls: 'Дистрибьютор' },
  regional: { fit: { retail: 1, kids: 0.6, derma: 0.1 }, freq: [0.35, 0.65], assort: [10, 26], disc: [0.03, 0.1], cls: 'Розница' },
  stm: { fit: { stm: 3, retail: 0.8, kids: 0.5 }, budget: true, freq: 0.8, assort: [25, 40], disc: [0.22, 0.3], cls: 'Дискаунтер' },
  prof: { fit: { prof: 1 }, freq: [0.45, 0.7], assort: [20, 40], disc: [0.08, 0.15], cls: 'Дистрибьютор проф. косметики' },
  profDirect: { fit: { prof: 1 }, freq: [0.3, 0.5], assort: [8, 15], disc: [0.03, 0.08], cls: 'Салон' },
  profChain: { fit: { prof: 1 }, freq: 0.75, assort: [30, 45], disc: [0.1, 0.16], cls: 'Сеть салонов' },
  profEcom: { fit: { prof: 1, retail: 0.15 }, freq: 0.85, assort: [30, 50], disc: [0.1, 0.16], cls: 'Интернет-магазин' },
  pharma: { fit: { derma: 1, kids: 0.35 }, freq: 0.75, assort: [18, 30], disc: [0.15, 0.22], cls: 'Аптечная сеть' },
  derma: { fit: { derma: 1, retail: 0.08 }, freq: 0.6, assort: [12, 22], disc: [0.08, 0.14], cls: 'Аптека' },
  exportRetail: { fit: { retail: 1, kids: 0.6 }, freq: [0.35, 0.5], assort: [25, 45], disc: [0.18, 0.25], cls: 'Экспорт' },
  exportProf: { fit: { prof: 1 }, freq: [0.35, 0.5], assort: [15, 30], disc: [0.15, 0.22], cls: 'Экспорт' },
};
const PROF_KINDS = new Set(['prof', 'profDirect', 'profChain', 'profEcom', 'exportProf']);

const cache = new Map();
/** Model for seed/lastYM (built once and reused). */
export function getDemoModel({ seed = DEMO_SEED, lastYM = DEMO_LAST_YM } = {}) {
  const key = `${seed}|${lastYM}`;
  if (!cache.has(key)) cache.set(key, buildDemoModel({ seed, lastYM }));
  return cache.get(key);
}

export function buildDemoModel({ seed = DEMO_SEED, lastYM = DEMO_LAST_YM } = {}) {
  const t0 = Date.now();
  const sub = tag => rng(hash32(seed, tag)); // independent streams: changing one block does not shift the others
  const firstYM = FIRST_YEAR * 100 + 1;
  const months = monthsBetween(firstYM, lastYM);
  const yearOf = ym => Math.floor(ym / 100);

  // ═══ PRODUCTS ═══
  const items = [];
  const names = new Set();
  const addItem = it => {
    if (names.has(it.name)) return;
    names.add(it.name);
    it.id = items.length;
    it.code = `НР-${String(10001 + items.length * 3).padStart(6, '0')}`;
    items.push(it);
  };
  for (const B of C.BRANDS) {
    const r = sub('brand:' + B.b);
    for (const L of B.lines) {
      const combos = [];
      for (const v of L.vars) for (const t of L.types) combos.push([t, v]);
      for (let i = combos.length - 1; i > 0; i--) {
        const j = Math.floor(r.next() * (i + 1));
        [combos[i], combos[j]] = [combos[j], combos[i]];
      }
      for (const [t, v] of combos.slice(0, L.n)) {
        const tg = t[3] || L.tg;
        addItem({
          name: [B.b, t[0], v, t[1]].filter(Boolean).join(' '),
          brand: B.b,
          trademark: B.tm,
          sub: L.sub,
          tg,
          tgTop: C.TG_DIRECTION[tg] || tg,
          kind: L.kind || 'Продукция',
          mc: L.mc,
          season: L.season || B.season,
          channel: L.stm ? 'stm' : B.channel,
          growth: B.growth,
          margin: B.margin * r.uni(0.9, 1.1),
          price0: Math.round(B.price * t[2] * r.uni(0.85, 1.2)),
          pop: r.lognorm(0.85),
          archive: !!L.archive,
          launchWin: B.launch,
          novFrac: B.novFrac || 0,
        });
      }
    }
  }
  const brandOf = Object.fromEntries(C.BRANDS.map(B => [B.b, B]));
  for (const [b, nm, mult] of C.GIFT_SETS) {
    const B = brandOf[b];
    addItem({
      name: `${b} ${nm}`, brand: b, trademark: B.tm, sub: '', tg: 'Подарочные наборы', tgTop: 'Подарочные наборы',
      kind: 'Набор', mc: 182, season: 'gifts', channel: B.channel, growth: B.growth, margin: B.margin,
      price0: Math.round(B.price * mult), pop: 0.9, archive: false, novFrac: 0,
    });
  }
  for (const [b, nm, mult, ch] of C.PROMO_ITEMS) {
    const B = brandOf[b];
    addItem({
      name: `${b} ${nm}`, brand: b, trademark: B.tm, sub: '', tg: 'Промо-материалы', tgTop: 'Промо-материалы',
      kind: 'Товар', mc: 191, season: 'flat', channel: ch, growth: 0, margin: 0.05,
      price0: Math.max(5, Math.round(B.price * mult)), pop: 0.12, archive: false, novFrac: 0,
    });
  }
  // lifecycle, stage, prices
  {
    const r = sub('lifecycle');
    const lastLaunch = ymAdd(lastYM, -2);
    for (const it of items) {
      it.launch = null;
      it.phaseOut = null;
      if (it.archive) it.phaseOut = ymAdd(firstYM, r.int(5, 20));
      else if (it.launchWin && r.chance(it.novFrac)) {
        const [a, b] = it.launchWin;
        it.launch = ymAdd(a, r.int(0, Math.max(0, ymDiff(Math.min(b, lastLaunch), a))));
      } else if (it.mc !== 191 && it.mc !== 182 && r.chance(0.09)) it.launch = ymAdd(202502, r.int(0, ymDiff(lastLaunch, 202502)));
      else if (it.mc !== 191 && r.chance(0.05)) it.phaseOut = ymAdd(firstYM, r.int(9, 29));
      if (it.launch) it.pop *= 0.55; // a new product starts with a smaller shelf share
      if (!it.archive && it.mc > 0 && it.mc !== 191 && it.mc !== 182 && r.chance(0.025)) it.mc = -1; // no incentive group
      it.stage = it.launch
        ? it.launch >= ymAdd(lastYM, -11)
          ? 'Новинка'
          : 'Рост'
        : it.phaseOut
          ? 'Выведение'
          : r.chance(0.03)
            ? NA
            : it.growth >= 0.15
              ? 'Рост'
              : it.growth <= -0.08
                ? 'Спад'
                : 'Зрелость';
      const infl = r.uni(0.05, 0.09);
      it.priceIdx = {};
      for (let y = FIRST_YEAR, k = 1; y <= yearOf(lastYM) + 1; y++, k *= 1 + infl) it.priceIdx[y] = k;
      it.basePrice = r.chance(0.03) ? 0 : Math.round(it.price0 * it.priceIdx[PLAN_YEAR]);
      it.segment = cleanGroup(skUpper.get(it.mc)) || null; // upper incentive level (plan group)
      it.motivLower = it.mc > 0 ? cleanGroup(skName.get(it.mc)) : null;
    }
  }
  const priceOf = (it, ym) => it.price0 * it.priceIdx[yearOf(ym)];
  /** share of a product's "normal" sales in a month: 0 — not sold; ramp-up after launch, decline before phase-out */
  const lifecycle = (it, ym) => {
    if (it.launch) {
      const k = ymDiff(ym, it.launch);
      if (k < 0) return 0;
      if (k < 3) return [0.35, 0.65, 0.85][k];
    }
    if (it.phaseOut) {
      const k = ymDiff(it.phaseOut, ym);
      if (k < 0) return 0;
      if (k < 3) return [0.25, 0.45, 0.7][k];
    }
    return 1;
  };

  // ═══ SHORTAGE EPISODES and stock cover zones for the last month ═══
  const shortage = items.map(() => new Map()); // ym → shipped share of demand
  {
    const r = sub('shortage');
    const addEp = (it, start, len, s) => {
      for (let k = 0; k < len; k++) {
        const ym = ymAdd(start, k);
        if (ym > lastYM) break;
        shortage[it.id].set(ym, Math.max(0, Math.min(0.95, s * r.uni(0.8, 1.15))));
      }
    };
    for (const it of items) {
      if (r.chance(0.2)) {
        const n = r.int(1, 2);
        for (let e = 0; e < n; e++) addEp(it, ymAdd(firstYM, r.int(2, months.length - 2)), r.int(1, 3), r.uni(0.1, 0.7));
      }
      // spikes: hair-colour supply disruption in spring 2025 and kids' line before the 2026 school season
      if ((it.brand === 'ГАММА' || it.brand === 'КОРОЛЕВНА') && it.tg !== 'Краски для бровей и ресниц' && r.chance(0.45)) {
        addEp(it, 202503, r.int(1, 2), r.uni(0.25, 0.6));
      }
      if ((it.brand === 'МЕГАДРАКОНЫ' || it.brand === 'FRUIT DRAGONS') && r.chance(0.55)) {
        addEp(it, 202608, r.int(1, 2), r.uni(0.2, 0.6));
      }
      const w = STOCK_REGIMES.map(z => z.p);
      it.regime = r.weighted(w);
      // current shortage (<15-day zone) — often with short shipments to clients in recent months
      if (it.regime === 0 && r.chance(0.5)) addEp(it, ymAdd(lastYM, -1), 2, r.uni(0.5, 0.85));
    }
  }

  // ═══ DEPARTMENTS ═══
  const depts = DEPTS_WL.map(name => ({ name, parent: C.DEPT_PARENT[name] || NA }));
  const deptIdx = new Map(depts.map((d, i) => [d.name, i]));

  // ═══ CLIENTS ═══
  const partners = [];
  {
    const r = sub('partners');
    const used = new Set();
    const regions = Object.entries(C.GEO);
    const pickTerr = () => {
      const t1 = regions[r.weighted(regions.map(([d]) => C.DISTRICT_WEIGHT[d]))][0];
      return { t1, t2: r.pick(C.GEO[t1]) };
    };
    const uniqueName = make => {
      for (let i = 0; i < 200; i++) {
        const n = make();
        if (!used.has(n)) {
          used.add(n);
          return n;
        }
      }
      throw new Error('demo: failed to generate a unique client name');
    };
    const root = () => r.pick(C.NAME_ROOTS);
    const range = v => (Array.isArray(v) ? r.uni(v[0], v[1]) : v);
    const add = (p, kind) => {
      const K = KINDS[kind];
      const o = {
        kind,
        classifier: K.cls,
        entity: p.name.startsWith('ИП ') ? 'ИП' : 'Юр. лицо',
        freq: range(K.freq),
        assortN: Math.round(range(K.assort)),
        disc: range(K.disc),
        growth: p.growth ?? Math.max(-0.3, Math.min(0.4, 0.02 + 0.1 * r.normal())),
        start: firstYM,
        end: null,
        planOnly: false,
        deptBefore: null,
        switchYM: null,
        dept2: null,
        ...p,
      };
      if (!o.t1) Object.assign(o, pickTerr());
      used.add(o.name);
      partners.push(o);
      return o;
    };
    for (const k of C.KEY_ACCOUNTS) {
      add({ name: k.name, size: k.size, t1: k.t1, t2: k.t2, growth: k.growth, dept: k.dept || 'Сетевые продажи-Ритейл', dept2: k.second || null, key: true }, k.kids ? 'keyKids' : 'key');
    }
    for (const n of C.MARKETPLACES) add({ name: n, size: r.uni(16e6, 38e6), t1: 'Центральный ФО', t2: 'Москва', dept: 'E-comm-Маркетплейсы', growth: r.uni(0.06, 0.2) }, 'market');
    for (let i = 0; i < 8; i++) {
      add({ name: uniqueName(() => `${root()} Онлайн ООО`), size: r.uni(0.8e6, 3.5e6), t1: r.chance(0.6) ? 'Центральный ФО' : 'Северо-Западный ФО', t2: null, dept: 'E-comm-Ритейл' }, 'ecom');
      const p = partners[partners.length - 1];
      p.t2 = p.t1 === 'Центральный ФО' ? 'Москва' : 'Санкт-Петербург';
    }
    for (let i = 0; i < 12; i++) add({ name: uniqueName(() => `${root()} Ритейл ООО`), size: r.uni(2e6, 7e6), dept: 'Сетевые продажи-Ритейл' }, 'chain');
    for (let i = 0; i < 24; i++) {
      add({ name: uniqueName(() => (r.chance(0.5) ? `ТД ${root()} ООО` : `${root()} Дистрибуция ООО`)), size: r.uni(3e6, 11e6), dept: 'Региональные продажи-Ритейл' }, 'distr');
    }
    for (let i = 0; i < 150; i++) {
      const nm = i < C.IP_NAMES.length ? C.IP_NAMES[i] : uniqueName(() => `${root()}${r.pick(C.NAME_SUFFIX)} ${r.chance(0.85) ? 'ООО' : 'АО'}`);
      add({ name: nm, size: Math.min(2e6, Math.max(0.05e6, 0.32e6 * r.lognorm(0.8))), dept: 'Региональные продажи-Ритейл' }, 'regional');
    }
    for (let i = 0; i < 5; i++) {
      const p = add({ name: uniqueName(() => `${r.pick(['Копейкин Двор', 'Экономия', 'Выгода', 'Низкоцен', 'Скидкино', 'Бережливый'])}${r.pick(['', ' Плюс', ' Маркет'])} ООО`), size: r.uni(2e6, 7e6), dept: 'СТМ, Дискаунтеры' }, 'stm');
      if (i < 3) Object.assign(p, { deptBefore: 'Архив СТМ', switchYM: 202501 });
    }
    for (let i = 0; i < 30; i++) {
      const p = add({ name: uniqueName(() => (r.chance(0.5) ? `${root()} Проф ООО` : `Бьюти Профи ${root()} ООО`)), size: r.uni(0.3e6, 2e6), dept: 'Региональные продажи-Проф' }, 'prof');
      if (i < 8) Object.assign(p, { deptBefore: 'Архив Профкосметика-Продажи', switchYM: 202501 });
    }
    for (let i = 0; i < 12; i++) add({ name: uniqueName(() => `Студия красоты ${root()} ООО`), size: r.uni(0.04e6, 0.3e6), t1: 'Центральный ФО', t2: r.pick(['Москва', 'Московская область']), dept: 'Отдел прямых продаж-Проф' }, 'profDirect');
    for (let i = 0; i < 6; i++) add({ name: uniqueName(() => `Сеть салонов ${root()} ООО`), size: r.uni(1e6, 3e6), dept: 'Сети-Проф' }, 'profChain');
    for (let i = 0; i < 4; i++) add({ name: uniqueName(() => `${root()} Профи Маркет ООО`), size: r.uni(0.8e6, 2.5e6), t1: 'Центральный ФО', t2: 'Москва', dept: 'E-comm-Проф' }, 'profEcom');
    for (let i = 0; i < 14; i++) add({ name: uniqueName(() => (r.chance(0.5) ? `Аптечная сеть ${root()} ООО` : `${root()}-Фарм АО`)), size: r.uni(1e6, 5e6), dept: 'Фарма' }, 'pharma');
    for (let i = 0; i < 10; i++) add({ name: uniqueName(() => `Аптека ${root()} ООО`), size: r.uni(0.3e6, 1.5e6), dept: 'Аптечная косметика-Ритейл' }, 'derma');
    for (const e of C.EXPORT_PARTNERS) {
      add({ name: e.name, size: r.uni(0.6e6, 3e6), t1: 'Экспорт', t2: e.t2, dept: e.prof ? 'Экспортные продажи-Проф' : 'Экспортные продажи-Ритейл' }, e.prof ? 'exportProf' : 'exportRetail');
    }
    for (const n of C.PLAN_ONLY) {
      const kind = /Проф/.test(n) ? 'prof' : /Аптека/.test(n) ? 'pharma' : 'regional';
      const dept = kind === 'prof' ? 'Региональные продажи-Проф' : kind === 'pharma' ? 'Фарма' : 'Региональные продажи-Ритейл';
      add({ name: n, size: r.uni(0.4e6, 1.5e6), dept, planOnly: true, start: ymAdd(lastYM, 3) }, kind);
    }
    // new and churned clients, territories without a contract, managers, codes
    const tmByRegion = new Map();
    let tmi = 0;
    for (const [, regs] of regions) for (const reg of regs) tmByRegion.set(reg, C.TM_NAMES[tmi++ % C.TM_NAMES.length]);
    let code = 100;
    for (const p of partners) {
      code += r.int(1, 9);
      p.code = `ПР-${String(code).padStart(5, '0')}`;
      const churnable = ['regional', 'prof', 'profDirect', 'derma', 'ecom', 'exportRetail'].includes(p.kind);
      if (!p.planOnly && churnable && r.chance(0.12)) p.start = ymAdd(202501, r.int(0, 17));
      else if (!p.planOnly && churnable && r.chance(0.09)) p.end = ymAdd(202503, r.int(0, 17));
      if (p.kind === 'regional' && r.chance(0.02)) p.t1 = p.t2 = null; // no contract territory
      const prof = PROF_KINDS.has(p.kind);
      p.rm = p.key
        ? C.RM_KEY_ACCOUNTS
        : p.kind === 'market' || p.kind === 'ecom'
          ? C.RM_ECOM
          : p.t1 === 'Экспорт'
            ? C.RM_EXPORT
            : p.kind === 'pharma' || p.kind === 'derma'
              ? C.RM_PHARMA
              : prof && (p.t1 === 'Центральный ФО' || p.t1 === 'Северо-Западный ФО')
                ? C.RM_PROF
                : C.RM_BY_DISTRICT[p.t1] || null;
      if (r.chance(0.03)) p.rm = null;
      p.tm = p.key || p.kind === 'market' || p.t1 === 'Экспорт' || !p.t2 ? null : tmByRegion.get(p.t2) || null;
      p.op = C.OPERATORS[hash32(p.name) % C.OPERATORS.length];
      p.planTarget = Math.max(-0.05, 0.12 + 0.08 * r.normal());
      p.oprRate = p.key || p.kind === 'market' ? r.uni(0.03, 0.06) : r.uni(0, 0.02);
      p.deliveryZone = p.t1 === 'Экспорт' ? 'Экспорт' : p.t2 === 'Москва' || p.t2 === 'Московская область' ? 'Зона 1' : r.pick(['Зона 2', 'Зона 3']);
    }
  }

  // ═══ CLIENT ASSORTMENTS ═══
  const assort = partners.map(p => {
    const K = KINDS[p.kind];
    const r = sub('assort:' + p.name);
    const weightOf = it => {
      if (it.channel === 'stm') return p.kind === 'stm' ? K.fit.stm * it.pop : 0;
      if (K.budget && !BUDGET.has(it.brand)) return 0;
      const f = K.fit[it.channel] || 0;
      return f * it.pop * (it.mc === 182 ? 0.6 : 1);
    };
    const chosen = r.sampleWeighted(items, weightOf, p.assortN);
    const tot = chosen.reduce((s, it) => s + weightOf(it), 0) || 1;
    return chosen.map(it => ({ it, share: weightOf(it) / tot }));
  });

  // ═══ SALES and UNFULFILLED DEMAND ═══
  // sales:  [item, dept, partner, ym, rub, qty]      (model indexes)
  // defect: [item, dept, partner, ym, qty, rub]      (raw, including repeat orders)
  // dayMax: "item|partner|ym" → largest single-day unfulfilled quantity
  const sales = [];
  const defect = [];
  const dayMax = new Map();
  const demandQty = items.map(() => new Map()); // ym → demand, units (shipped + short-shipped)
  const shippedQty = items.map(() => new Map()); // ym → shipped, units
  const bumpMap = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  {
    const r = sub('sales');
    for (let pi = 0; pi < partners.length; pi++) {
      const p = partners[pi];
      if (p.planOnly) continue;
      for (const ym of months) {
        if (ym < p.start || (p.end && ym > p.end)) continue;
        const d = deptIdx.get(p.deptBefore && ym < p.switchYM ? p.deptBefore : p.dept);
        const d2 = p.dept2 ? deptIdx.get(p.dept2) : null;
        const t = ymDiff(ym, firstYM) / 12;
        const pTrend = Math.pow(1 + p.growth, t) * (p.start > firstYM ? Math.min(1, 0.4 + 0.2 * ymDiff(ym, p.start)) : 1);
        const mo = (ym % 100) - 1;
        // the client's basket is split among products currently on sale: new products replace
        // the old range (cannibalisation); growth comes from brand and client trends
        let active = 0;
        for (const { it, share } of assort[pi]) active += share * lifecycle(it, ym);
        if (active <= 0) continue;
        const basket = 1 / active;
        for (const { it, share } of assort[pi]) {
          const lf = lifecycle(it, ym);
          if (lf <= 0) continue;
          if (!r.chance(p.freq)) continue;
          const listRub = p.size * share * basket * C.SEASON[it.season][mo] * CAL[mo] * Math.pow(1 + it.growth, t) * lf * pTrend;
          const price = priceOf(it, ym);
          let q = (listRub / price / p.freq) * r.lognorm(0.35);
          let qty = Math.floor(q) + (r.next() < q - Math.floor(q) ? 1 : 0);
          if (qty <= 0) continue;
          const s = shortage[it.id].get(ym);
          const shipped = s == null ? qty : Math.min(qty, Math.round(qty * s));
          const lost = qty - shipped;
          bumpMap(demandQty[it.id], ym, qty);
          bumpMap(shippedQty[it.id], ym, shipped);
          const net = price * (1 - p.disc);
          if (shipped > 0) {
            if (d2 != null && shipped >= 4 && r.chance(0.3)) {
              const q2 = Math.max(1, Math.round(shipped * r.uni(0.12, 0.3)));
              sales.push([it.id, d2, pi, ym, Math.round(q2 * net * r.uni(0.98, 1.02)), q2]);
              sales.push([it.id, d, pi, ym, Math.round((shipped - q2) * net * r.uni(0.98, 1.02)), shipped - q2]);
            } else sales.push([it.id, d, pi, ym, Math.round(shipped * net * r.uni(0.98, 1.02)), shipped]);
          }
          // unfulfilled demand: a short shipment during a shortage or a small background rejection; the client re-orders
          let lostQ = lost;
          if (!lostQ && r.chance(0.045)) lostQ = Math.max(1, Math.round(qty * r.uni(0.03, 0.25)));
          if (lostQ > 0) {
            const raw = Math.max(lostQ, Math.round(lostQ * r.uni(1.0, lost ? 2.6 : 1.6)));
            defect.push([it.id, d, pi, ym, raw, Math.round(raw * net)]);
            dayMax.set(`${it.id}|${pi}|${ym}`, Math.max(1, Math.round(lostQ * r.uni(0.45, 1.0))));
          }
        }
      }
    }
  }

  // ═══ STOCK ═══ [item, ym, onHand, free]
  const stock = [];
  {
    const r = sub('stock');
    const prev3 = ym => [ymAdd(ym, -3), ymAdd(ym, -2), ymAdd(ym, -1)];
    for (const it of items) {
      it.finalDays = r.uni(...STOCK_REGIMES[it.regime].d); // stock cover in days for the last month
      it.baseDays = 45 * r.lognorm(0.3); // the product's usual cover at the start of history
      const firstStock = it.launch ? ymAdd(it.launch, -1) : firstYM;
      let lastOn = 0;
      for (const ym of months) {
        if (ym < firstStock) continue;
        const dem = demandQty[it.id];
        let rate = prev3(ym).reduce((s, k) => s + (dem.get(k) || 0), 0) / 91;
        if (!rate) rate = (dem.get(ym) || dem.get(ymAdd(ym, 1)) || 0) / 30;
        // cover drifts from the usual level towards the last-month zone: from a year before the cut-off to a quarter before it
        const w = Math.max(0, Math.min(1, (ymDiff(ym, lastYM) + 12) / 9));
        const days = Math.exp((1 - w) * Math.log(it.baseDays) + w * Math.log(it.finalDays)) * r.lognorm(0.15);
        const d = shortage[it.id].has(ym) ? r.uni(1, 9) : days;
        let on;
        if (ym === lastYM) {
          // last-month cover zone — same formula the dashboard uses:
          // stock ÷ (sales over the 3 months before the last one ÷ number of days)
          const sold = prev3(ym).reduce((s, k) => s + (shippedQty[it.id].get(k) || 0), 0);
          const rd = prev3(ym).reduce((s, k) => s + daysIn(k), 0);
          on = sold > 0 ? Math.round((sold / rd) * it.finalDays) : Math.round(lastOn * 0.97);
        } else if (it.phaseOut && ym > it.phaseOut) on = Math.round(lastOn * r.uni(0.93, 0.99)); // dead stock
        else on = Math.round(rate * d);
        if (it.phaseOut && ym === ymAdd(it.phaseOut, 1) && r.chance(0.4)) on = 0; // remaining stock sold off
        if (on <= 0) {
          lastOn = 0;
          continue;
        }
        lastOn = on;
        stock.push([it.id, ym, on, Math.round(on * r.uni(0.62, 0.97))]);
      }
    }
  }

  // ═══ PRODUCTION ═══ [item, ym, approved, planned, made] — from 2025, planned one month ahead
  const prod = [];
  {
    const r = sub('prod');
    const prodFrom = 202501;
    for (const it of items) {
      if (it.kind !== 'Продукция') continue;
      for (let ym = prodFrom; ym <= ymAdd(lastYM, 1); ym = ymAdd(ym, 1)) {
        if (lifecycle(it, ym) <= 0 && lifecycle(it, ymAdd(ym, 1)) <= 0) continue;
        if (!r.chance(0.55)) continue;
        const dem = demandQty[it.id];
        const base = ([1, 2, 3].reduce((s, k) => s + (dem.get(ymAdd(ym, -k)) || 0), 0) / 3) || (dem.get(ym) || 0);
        if (base <= 0) continue;
        const appr = Math.round(base * r.uni(1.3, 2.2));
        const plan = Math.round(appr * r.uni(0.8, 1.0));
        let fulfil = r.uni(0.82, 1.04);
        if (ym === 202503 && it.tgTop === 'КРАСКИ ДЛЯ ВОЛОС') fulfil = r.uni(0.4, 0.7);
        if (shortage[it.id].has(ym)) fulfil *= r.uni(0.5, 0.8);
        const made = ym <= lastYM ? Math.round(plan * fulfil) : 0;
        if (appr || plan || made) prod.push([it.id, ym, appr, plan, made]);
      }
    }
  }

  // ═══ OPERATIONAL PLAN (by client) ═══
  // Rows as in the ERP: department, client (Analytics 4), group (Analytics 6 — upper or lower
  // incentive level, or the technical '<прочие …>'), regional/territory manager/region, month, amount ₽.
  // products phased out before the plan year starts are excluded from that year's plan
  const plannable = it => !it.phaseOut || it.phaseOut >= PLAN_YEAR * 100 + 1;
  const planRows = [];
  const planMonths = monthsBetween(PLAN_YEAR * 100 + 1, PLAN_YEAR * 100 + 12);
  {
    const r = sub('plan');
    const base = new Map(); // p|seg|month(1..12) → prior-year revenue
    const recent = new Map(); // p|seg → revenue over the last 6 months of actuals
    const segOf = it => it.segment || '<прочие Аналитика для мотивации>';
    const recentFrom = ymAdd(lastYM, -5);
    for (const s of sales) {
      const it = items[s[0]];
      if (!plannable(it)) continue;
      if (yearOf(s[3]) === PLAN_YEAR - 1) bumpMap(base, `${s[2]}|${segOf(it)}|${s[3] % 100}`, s[4]);
      if (s[3] >= recentFrom) bumpMap(recent, `${s[2]}|${segOf(it)}`, s[4]);
    }
    const segsOf = new Map();
    for (const k of [...base.keys(), ...recent.keys()]) {
      const [pi, seg] = k.split('|');
      if (!segsOf.has(+pi)) segsOf.set(+pi, new Set());
      segsOf.get(+pi).add(seg);
    }
    for (let pi = 0; pi < partners.length; pi++) {
      const p = partners[pi];
      if (p.end && p.end < PLAN_YEAR * 100 + 1) continue;
      const dept = p.dept;
      const prof = PROF_KINDS.has(p.kind);
      let segs = segsOf.get(pi);
      if (p.planOnly) segs = new Set(prof ? ['ATELIER PROF'] : p.kind === 'pharma' ? ['Захват'] : ['Удержание', 'Регулярный ассортимент']);
      if (!segs) continue;
      for (const seg of segs) {
        // professional products are often planned without a group — the technical '<прочие …>'
        const raw = prof && seg === 'ATELIER PROF' && r.chance(0.35) ? '<прочие Аналитика для мотивации>' : seg;
        const rec = (recent.get(`${pi}|${seg}`) || 0) / 6;
        for (const ym of planMonths) {
          const mo = ym % 100;
          let b = base.get(`${pi}|${seg}|${mo}`) || 0;
          if (!b) b = rec * C.SEASON.flat[mo - 1];
          if (!b && p.planOnly) b = (p.size * 0.85 * C.SEASON.flat[mo - 1]) / segs.size;
          const sum = round3(b * (1 + p.planTarget) * r.lognorm(0.08));
          if (sum > 0) planRows.push({ dept, partner: pi, a6: raw, ym, sum });
        }
      }
    }
  }

  // ═══ ANALYTICAL FORECAST (by product, units) ═══
  const forecast = [];
  let forecastUnmappedQty = 0;
  {
    const r = sub('forecast');
    for (const it of items) {
      const dem = demandQty[it.id];
      const recent = [1, 2, 3].reduce((s, k) => s + (dem.get(ymAdd(lastYM, 1 - k)) || 0), 0) / 3;
      for (let mo = 1; mo <= 12; mo++) {
        const ym = FC_YEAR * 100 + mo;
        if (lifecycle(it, ym) <= 0) continue;
        let q = (dem.get(ym - 100) || 0) * (1 + it.growth);
        if (!q) q = recent * (C.SEASON[it.season][mo - 1] / C.SEASON[it.season][(lastYM % 100) - 1]);
        q = Math.round(q * r.uni(0.88, 1.12));
        if (q > 0) forecast.push([it.id, ym, q]);
      }
    }
    // forecast products absent from the report universe (cannot be mapped)
    forecastUnmappedQty = Math.round(forecast.reduce((s, f) => s + f[2], 0) * 0.012);
  }

  // ═══ STRATEGIC PLAN (department × lower incentive level × month, ₽) ═══
  const strat = [];
  {
    const r = sub('strat');
    // base — the same month last year, but not below the Q4 run rate: lines launched last year
    // are planned from the current sales level rather than from a partial year
    const base = new Map();
    const q4 = new Map();
    const q4From = (PLAN_YEAR - 1) * 100 + 10;
    for (const s of sales) {
      if (yearOf(s[3]) !== PLAN_YEAR - 1 || !plannable(items[s[0]])) continue;
      const ml = items[s[0]].motivLower;
      if (!ml) continue;
      bumpMap(base, `${s[1]}|${ml}|${s[3] % 100}`, s[4]);
      if (s[3] >= q4From) bumpMap(q4, `${s[1]}|${ml}`, s[4] / 3);
    }
    const deptBias = depts.map(() => r.uni(0.05, 0.22));
    for (const [dml, run] of q4) for (let mo = 1; mo <= 12; mo++) if (!base.has(`${dml}|${mo}`)) base.set(`${dml}|${mo}`, 0);
    for (const [k, v] of base) {
      const [d, ml, mo] = k.split('|');
      const b = Math.max(v, (q4.get(`${d}|${ml}`) || 0) * 0.9);
      const sum = round3(b * (1 + deptBias[+d]) * r.lognorm(0.05));
      if (sum > 0) strat.push({ dept: depts[+d].name, motiv: ml, ym: PLAN_YEAR * 100 + +mo, sum });
    }
    // a launch that already has a plan but no products yet
    for (let mo = 7; mo <= 12; mo++) {
      strat.push({ dept: 'Сетевые продажи-Ритейл', motiv: 'ПТИЧКА Новинки (Мотивация)', ym: PLAN_YEAR * 100 + mo, sum: 2_400_000 });
      strat.push({ dept: 'Региональные продажи-Ритейл', motiv: 'ПТИЧКА Новинки (Мотивация)', ym: PLAN_YEAR * 100 + mo, sum: 1_100_000 });
    }
    // a strategic-plan department that is not in the report
    for (let mo = 1; mo <= 12; mo++) strat.push({ dept: 'Новые рынки', motiv: 'Регулярный ассортимент', ym: PLAN_YEAR * 100 + mo, sum: 3_500_000 });
  }

  // ═══ indexes for the "Client agent" API ═══
  const salesByPartner = partners.map(() => []);
  sales.forEach((s, i) => salesByPartner[s[2]].push(i));
  const defectByPartner = partners.map(() => []);
  defect.forEach((s, i) => defectByPartner[s[2]].push(i));
  const planByPartner = partners.map(() => []);
  planRows.forEach((s, i) => planByPartner[s.partner].push(i));

  const model = {
    seed,
    firstYM,
    lastYM,
    months,
    items,
    depts,
    partners,
    assort,
    sales,
    defect,
    dayMax,
    stock,
    prod,
    planRows,
    forecast,
    forecastUnmappedQty,
    strat,
    salesByPartner,
    defectByPartner,
    planByPartner,
    builtMs: 0,
  };
  model.builtMs = Date.now() - t0;
  return model;
}
