// DATA_SOURCE=demo: dashboard snapshot from the demo model (demo/model.js).
//
// Mirrors the OLAP source path (report/olapSnapshot.js) on synthetic facts: the same registries
// filled in the same order, the same unfulfilled-demand de-dup, the same plan roll-up to the upper
// incentive level, the same packing (snapshotCore.packSnapshot). Only fact retrieval differs.
import { getDemoModel } from './model.js';
import { FIRST_YEAR, FC_YEAR } from '../report/reportConfig.js';
import { NA, cleanGroup, planGroup, newRegistries, itemOut, partnerDims, dedupDefect, packSnapshot } from '../report/snapshotCore.js';

const ru = (a, b) => a.localeCompare(b, 'ru');

export async function buildDemoSnapshot(opts = {}) {
  const t0 = Date.now();
  const M = getDemoModel(opts);
  const R = newRegistries();
  const { items, depts, partners, a6, motivLowers } = R;
  const pName = i => M.partners[i].name;
  const dName = i => M.depts[i].name;

  // pre-seed partners as the cube path does: partners with actuals in report departments, alphabetically
  const seeded = [...new Set(M.sales.map(s => s[2]))].map(pName).sort(ru);
  for (const n of seeded) partners.id(n);

  // SALES: the product registry follows order of appearance in sales
  const sales = M.sales.map(s => [items.id(M.items[s[0]].name), depts.id(dName(s[1])), partners.id(pName(s[2])), s[3], s[4], s[5]]);
  // UNFULFILLED DEMAND + de-dup (dayMax is re-keyed to snapshot ids)
  const defect = M.defect.map(d => [items.id(M.items[d[0]].name), depts.id(dName(d[1])), partners.id(pName(d[2])), d[3], d[4], d[5]]);
  const dayMax = new Map();
  for (const [k, v] of M.dayMax) {
    const [i, p, ym] = k.split('|');
    dayMax.set(`${items.get(M.items[+i].name)}|${partners.get(pName(+p))}|${ym}`, v);
  }
  dedupDefect(sales, defect, dayMax);
  // STOCK and PRODUCTION — only for products in the universe (with sales)
  const stock = [];
  for (const r of M.stock) {
    const it = items.get(M.items[r[0]].name);
    if (it !== undefined) stock.push([it, r[1], r[2], r[3]]);
  }
  const prod = [];
  for (const r of M.prod) {
    const it = items.get(M.items[r[0]].name);
    if (it !== undefined) prod.push([it, r[1], r[2], r[3], r[4]]);
  }
  // PLAN: roll-up by (department, client, plan group, month); group normalised to the upper level
  const planMap = new Map();
  for (const r of M.planRows) {
    const d = depts.id(r.dept);
    const p = partners.id(pName(r.partner));
    const g = a6.id(planGroup(r.a6));
    const key = d + '|' + p + '|' + g + '|' + r.ym;
    let v = planMap.get(key);
    if (!v) {
      v = [d, p, g, r.ym, 0, 0];
      planMap.set(key, v);
    }
    v[4] += r.sum;
  }
  const plan = Array.from(planMap.values()).filter(v => v[4] || v[5]);
  // products with attributes
  const byName = new Map(M.items.map(it => [it.name, it]));
  const itemsOut = items.list.map(name => {
    const it = byName.get(name);
    return itemOut(
      name,
      {
        brand: it.brand,
        code: it.code,
        sub: it.sub,
        tg: it.tg,
        stage: it.stage,
        tgTop: it.tgTop,
        kind: it.kind,
        mc: it.mc,
        trademark: it.trademark,
      },
      R,
    );
  });
  // client territories and managers
  const partnerByName = new Map(M.partners.map(p => [p.name, p]));
  const dims = partnerDims(
    partners.list,
    name => {
      const p = partnerByName.get(name);
      return p && p.t1 ? { t1: p.t1, t2: p.t2 || NA } : undefined;
    },
    name => partnerByName.get(name)?.rm,
    name => partnerByName.get(name)?.tm,
  );
  // FORECAST
  const fmap = new Map();
  let mappedQty = 0;
  const fcMonths = new Set();
  const fcPositions = new Set();
  for (const [i, ym, q] of M.forecast) {
    fcMonths.add(ym);
    fcPositions.add(i);
    const it = items.get(M.items[i].name);
    if (it === undefined) continue;
    mappedQty += q;
    const key = it + '|' + ym;
    const v = fmap.get(key);
    if (v) v[2] += q;
    else fmap.set(key, [it, ym, q]);
  }
  const forecast = Array.from(fmap.values()).filter(v => v[2]);
  const totalQty = mappedQty + M.forecastUnmappedQty;
  const forecastInfo = {
    ok: true,
    scenario: 'Прогноз продаж',
    vidPlana: 'Прогноз продаж',
    year: FC_YEAR,
    months: Array.from(fcMonths).sort((a, b) => a - b),
    positions: fcPositions.size + 9,
    totalQty,
    mappedQty,
    unmappedQty: totalQty - mappedQty,
  };
  // STRATEGIC PLAN: departments only from the report; incentive groups go to the registry (new ones are added)
  const spMap = new Map();
  let total = 0,
    mapped = 0;
  const unmatchedDepts = new Set();
  const spMonths = new Set();
  for (const r of M.strat) {
    total += r.sum;
    spMonths.add(r.ym);
    const d = depts.get(r.dept);
    if (d === undefined) {
      unmatchedDepts.add(r.dept);
      continue;
    }
    const ml = motivLowers.id(cleanGroup(r.motiv) || NA);
    mapped += r.sum;
    const key = d + '|' + ml + '|' + r.ym;
    const v = spMap.get(key);
    if (v) v[3] += r.sum;
    else spMap.set(key, [d, ml, r.ym, r.sum]);
  }
  const stratPlan = Array.from(spMap.values()).filter(v => v[3]);
  const stratInfo = {
    ok: true,
    scenario: 'План по клиентам',
    article: `План продаж по подразделениям ${FC_YEAR} по месяцам`,
    months: Array.from(spMonths).sort((a, b) => a - b),
    total,
    mapped,
    unmatched: total - mapped,
    unmatchedDepts: Array.from(unmatchedDepts),
  };
  // BASE PRICES
  const basePrices = items.list.map(name => byName.get(name).basePrice || 0);
  const basePriceInfo = { ok: true, withPrice: basePrices.filter(Boolean).length, total: basePrices.length };

  const deptParentByName = new Map(M.depts.map(d => [d.name, d.parent]));
  return packSnapshot({
    source: 'demo',
    t0,
    firstYear: FIRST_YEAR,
    R,
    itemsOut,
    deptParentByName,
    dims,
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
  });
}
