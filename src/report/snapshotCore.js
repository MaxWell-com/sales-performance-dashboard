// Shared snapshot core of the sales dashboard — the same for every data source.
//
// A source (OLAP cube or demo generator) only fetches facts and dictionaries. The "name → integer id"
// registries, incentive-group rules, unfulfilled-demand de-duplication and the assembly of the
// snapshot object live here, so the snapshot shape the dashboard receives is identical for any
// source. Tuple layout (column indexes are read by dashboard.template.html):
//
//   items[i]   { n, b, c, g, sb, tg, st, tgt, vk, ml, mu, tm }   attributes are ids in the registries below
//   sales      [itemId, deptId, partId, ym, rub, qty]
//   defect     [itemId, deptId, partId, ym, qty, rub, qtyDedup, rubDedup]
//   stock      [itemId, ym, onHand, free]
//   prod       [itemId, ym, approved, planned, made]
//   plan       [deptId, partId, a6Id, ym, rub, qty]
//   forecast   [itemId, ym, qty]
//   stratPlan  [deptId, motivLowerId, ym, rub]
//   basePrices [itemId] → price (0 — no price)
import { MOTIV_DIM } from './motivDim.js';

export const NA = '(не указано)';

/** "name → id" registry in order of first appearance. */
export class Registry {
  idx = new Map();
  list = [];
  id(name) {
    const n = name || NA;
    let i = this.idx.get(n);
    if (i === undefined) {
      i = this.list.length;
      this.idx.set(n, i);
      this.list.push(n);
    }
    return i;
  }
  get(name) {
    return this.idx.get(name || NA);
  }
}

// ——— incentive-group dictionary ———
export const skName = new Map();
export const skUpper = new Map();
export const nameUpper = new Map();
for (const r of MOTIV_DIM) {
  skName.set(r.sk, r.name);
  skUpper.set(r.sk, r.upper || r.name);
  nameUpper.set(r.name, r.upper || r.name);
}
/** Technical incentive values ('Неизвестно', 'Служебная', '<прочие …>') are not a group. */
export const cleanGroup = n => {
  if (!n) return null;
  if (n === 'Неизвестно' || n === 'Служебная') return null;
  if (n.startsWith('<')) return null;
  return n;
};
const upperSet = new Set();
skUpper.forEach(v => {
  const c = cleanGroup(v);
  if (c) upperSet.add(c);
});
/** The plan's "Analytics 6" value may be lower- or upper-level — normalise to the upper level. */
export const planGroup = a6 => (upperSet.has(a6) ? a6 : (nameUpper.get(a6) ?? a6));

/** All snapshot registries. The source fills them, the core assembles the object from them. */
export function newRegistries() {
  return {
    items: new Registry(),
    depts: new Registry(),
    partners: new Registry(),
    a6: new Registry(),
    tovgrps: new Registry(),
    stages: new Registry(),
    tgTops: new Registry(),
    kinds: new Registry(),
    motivLowers: new Registry(),
    motivUppers: new Registry(),
    trademarks: new Registry(),
    subbrands: new Registry(),
  };
}

/**
 * Product attributes → snapshot items[] record. `a`: { brand, code, sub, tg, stage, tgTop, kind,
 * mc (incentive-group sk, ≤0 — none), trademark }.
 */
export function itemOut(name, a, R) {
  const motivUpperName = a.mc > 0 ? cleanGroup(skUpper.get(a.mc)) : null;
  const motivLowerName = a.mc > 0 ? cleanGroup(skName.get(a.mc)) : null;
  const g = motivUpperName ? R.a6.id(motivUpperName) : -1;
  return {
    n: name,
    b: a.brand,
    c: a.code,
    g,
    sb: R.subbrands.id(a.sub || NA),
    tg: R.tovgrps.id(a.tg || NA),
    st: R.stages.id(a.stage || NA),
    tgt: R.tgTops.id(a.tgTop || NA),
    vk: R.kinds.id(a.kind || NA),
    ml: R.motivLowers.id(motivLowerName || NA),
    mu: R.motivUppers.id(motivUpperName || NA),
    tm: R.trademarks.id(a.trademark || NA),
  };
}

/**
 * Territories and managers per partner, aligned with partners.list.
 * terrOf(name) → { t1, t2 } | undefined; rmOf/tmOf(name) → name | undefined.
 */
export function partnerDims(partnerNames, terrOf, rmOf, tmOf) {
  const terr1 = new Registry();
  const terr2 = new Registry();
  const rmgrs = new Registry();
  const tmgrs = new Registry();
  const terr2Parent = [];
  const partTerr1 = [];
  const partTerr2 = [];
  const partRmgr = [];
  const partTmgr = [];
  for (const name of partnerNames) {
    const b = terrOf(name);
    const i1 = terr1.id(b ? b.t1 : NA);
    const i2 = terr2.id(b ? b.t2 : NA);
    partTerr1.push(i1);
    partTerr2.push(i2);
    if (terr2Parent[i2] === undefined) terr2Parent[i2] = i1;
    partRmgr.push(rmgrs.id(rmOf(name) || NA));
    partTmgr.push(tmgrs.id(tmOf(name) || NA));
  }
  return { terr1, terr2, terr2Parent, partTerr1, partTerr2, rmgrs, tmgrs, partRmgr, partTmgr };
}

/**
 * UNFULFILLED-DEMAND DE-DUPLICATION. The ERP logs every cancelled order line as unfulfilled demand,
 * and clients re-order the same product again and again. Per (product × client × month):
 * need = max(norm, largest single-day order of the month); loss = min(unfulfilled, need − sales), ≥0.
 * The norm is the average sales to the client over the 12 months before, counting only "clean"
 * months (no unfulfilled demand, after the first purchase); at least 3 such months are required,
 * otherwise 0. Rows of different departments in one cell get the same de-dup ratio. Appends
 * columns [6] and [7] to every defect row.
 * dayMax: Map "it|pid|ym" → largest single-day unfulfilled quantity, units.
 */
export function dedupDefect(sales, defect, dayMax) {
  const saleQ = new Map();
  for (const s of sales) {
    const k = `${s[0]}|${s[2]}|${s[3]}`;
    saleQ.set(k, (saleQ.get(k) || 0) + s[5]);
  }
  const defQ = new Map();
  for (const d of defect) {
    const k = `${d[0]}|${d[2]}|${d[3]}`;
    defQ.set(k, (defQ.get(k) || 0) + d[4]);
  }
  const ymSet = new Set();
  for (const s of sales) ymSet.add(s[3]);
  for (const d of defect) ymSet.add(d[3]);
  const allYm = Array.from(ymSet).sort((a, b) => a - b);
  const pairs = new Set();
  defQ.forEach((_v, k) => pairs.add(k.slice(0, k.lastIndexOf('|'))));
  const ratio = new Map();
  pairs.forEach(pair => {
    let bought = false;
    const hist = [];
    for (const ym of allYm) {
      const k = `${pair}|${ym}`;
      const sq = saleQ.get(k) || 0,
        dq = defQ.get(k) || 0;
      if (dq > 0) {
        const win = hist.slice(-12).filter(h => h.clean);
        const norm = win.length >= 3 ? win.reduce((a, h) => a + h.s, 0) / win.length : 0;
        const need = Math.max(norm, dayMax.get(k) || 0);
        ratio.set(k, Math.min(dq, Math.max(need - sq, 0)) / dq);
      }
      hist.push({ s: sq, clean: bought && dq <= 0 });
      if (sq > 0) bought = true;
    }
  });
  for (const d of defect) {
    const f = ratio.get(`${d[0]}|${d[2]}|${d[3]}`) ?? 1;
    d.length = 6;
    d.push(Math.round(d[4] * f), Math.round(d[5] * f));
  }
}

/** No de-duplication: the "without repeats" mode shows the raw unfulfilled demand. */
export function defectWithoutDedup(defect) {
  for (const d of defect) {
    d.length = 6;
    d.push(d[4], d[5]);
  }
}

/**
 * Builds the snapshot object, its JSON and a summary. The single place that defines the snapshot shape.
 * Returns { json, meta, forecast, forecastInfo } — forecast/forecastInfo are also kept outside json
 * so the source can fall back to the previous snapshot's forecast on failure.
 */
export function packSnapshot(p) {
  const { R, itemsOut, deptParentByName, dims, firstYear, t0, source } = p;
  const { sales, defect, stock, prod, plan, forecast, forecastInfo, stratPlan, stratInfo } = p;
  const { basePrices, basePriceInfo } = p;
  const lastYM = stock.reduce((m, r) => Math.max(m, r[1]), 0);
  const firstYM = sales.reduce((m, r) => (r[3] < m ? r[3] : m), sales.length ? sales[0][3] : 0);
  const nBrands = new Set(itemsOut.map(i => i.b)).size;
  const firstYr = firstYM ? Math.floor(firstYM / 100) : firstYear;
  const scope = `${firstYr}+, ${nBrands} торг. марок`;
  const now = new Date();
  const obj = {
    gen: now.toISOString().slice(0, 10),
    builtAt: now.toISOString(), // for the "updated at" caption in the report header
    scope,
    firstYM,
    lastYM,
    items: itemsOut,
    a6groups: R.a6.list,
    tovgrps: R.tovgrps.list,
    stages: R.stages.list,
    tgTops: R.tgTops.list,
    kinds: R.kinds.list,
    motivLowers: R.motivLowers.list,
    // incentive group lower → upper (by name) — for strategic-plan groups without SKUs
    mlUpper: R.motivLowers.list.map(n => cleanGroup(nameUpper.get(n)) || NA),
    motivUppers: R.motivUppers.list,
    trademarks: R.trademarks.list,
    subbrands: R.subbrands.list,
    depts: R.depts.list,
    deptParents: R.depts.list.map(n => deptParentByName.get(n) || NA),
    partners: R.partners.list,
    terr1: dims.terr1.list,
    terr2: dims.terr2.list,
    terr2Parent: dims.terr2Parent,
    partTerr1: dims.partTerr1,
    partTerr2: dims.partTerr2,
    rmgrs: dims.rmgrs.list,
    tmgrs: dims.tmgrs.list,
    partRmgr: dims.partRmgr,
    partTmgr: dims.partTmgr,
    sales,
    defect,
    stock,
    prod,
    plan,
    forecast,
    forecastInfo,
    stratPlan,
    stratInfo,
    basePrices,
    basePriceInfo,
  };
  const json = JSON.stringify(obj);
  const meta = {
    gen: obj.gen,
    scope,
    firstYM,
    lastYM,
    items: itemsOut.length,
    depts: R.depts.list.length,
    partners: R.partners.list.length,
    sales: sales.length,
    defect: defect.length,
    stock: stock.length,
    prod: prod.length,
    plan: plan.length,
    forecast: forecast.length,
    forecastQty: forecastInfo.mappedQty ?? 0,
  };
  console.log(
    `[report/sales] ${source} snapshot built in ${((Date.now() - t0) / 1000).toFixed(1)}s: ` +
      `items=${meta.items} depts=${meta.depts} partners=${meta.partners} sales=${meta.sales} ` +
      `defect=${meta.defect} stock=${meta.stock} prod=${meta.prod} plan=${meta.plan} ` +
      `forecast=${forecast.length}(${forecastInfo.ok ? 'ok' : 'off:' + forecastInfo.error}) ` +
      `strat=${stratPlan.length}(${stratInfo.ok ? 'ok' : 'off:' + stratInfo.error}) ` +
      `lastYM=${lastYM} bytes=${json.length}`,
  );
  return { json, meta, forecast, forecastInfo };
}
