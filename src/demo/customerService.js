// "Client agent" in demo mode: the same responses as profiles/customerService.js (OLAP), but
// computed from the demo model. Sales, plan and unfulfilled demand come from the same facts as the
// dashboard snapshot, so the client card agrees with the main report. Point-in-time data the model
// lacks (receivables, open orders, client passport) is derived deterministically from the client
// and its sales — the same client always looks the same.
import { getDemoModel, ymAdd, daysIn } from './model.js';
import { rng, hash32 } from './random.js';
import { PLAN_YEAR } from '../report/reportConfig.js';
import { NA } from '../report/snapshotCore.js';

const ymKey = ym => `${Math.floor(ym / 100)}-${String(ym % 100).padStart(2, '0')}`;
const parseYM = (s, fb) => {
  const m = /^(\d{4})-(\d{2})$/.exec(s ?? '');
  return m ? Number(m[1]) * 100 + Number(m[2]) : fb;
};
/** Period as in the OLAP version: by default from January of the plan year to the last data month. */
function period(M, from, to) {
  const a = parseYM(from, PLAN_YEAR * 100 + 1);
  const b = parseYM(to, M.lastYM);
  return { from: a, to: b, pyFrom: a - 100, pyTo: b - 100 };
}
const clean = v => {
  const t = String(v ?? '').trim();
  if (!t || t === NA || t === 'Неизвестно' || t.startsWith('<')) return '';
  return t;
};
const ru = (a, b) => a.localeCompare(b, 'ru');
const sortRu = set => Array.from(set).sort(ru);
const partnerByCode = M => (M._byCode ??= new Map(M.partners.map((p, i) => [p.code, i])));
const partnerByName = M => (M._byName ??= new Map(M.partners.map((p, i) => [p.name, i])));
const itemAttrs = it => ({
  code: it.code,
  name: it.name,
  brand: it.brand || '— без марки —',
  group: it.tg || '— без группы —',
  kind: it.kind || '— не указан —',
});
/** Client's average monthly revenue over the 3 months up to the cut-off. */
function recentMonthly(M, pi) {
  const from = ymAdd(M.lastYM, -2);
  let rub = 0;
  for (const i of M.salesByPartner[pi]) {
    const s = M.sales[i];
    if (s[3] >= from) rub += s[4];
  }
  return rub / 3;
}
const asOfDate = M => `${ymKey(M.lastYM)}-${String(daysIn(M.lastYM)).padStart(2, '0')}`;

// ══════ client overview ══════
export async function getCustomerOverview(from, to) {
  const M = getDemoModel();
  const P = period(M, from, to);
  const fact = new Map(); // pi → {sales, qty, profit, salesPY}
  const get = pi => {
    let f = fact.get(pi);
    if (!f) fact.set(pi, (f = { sales: 0, qty: 0, profit: 0, salesPY: 0 }));
    return f;
  };
  for (const s of M.sales) {
    const ym = s[3];
    if (ym >= P.from && ym <= P.to) {
      const f = get(s[2]);
      f.sales += s[4];
      f.qty += s[5];
      f.profit += s[4] * M.items[s[0]].margin;
    } else if (ym >= P.pyFrom && ym <= P.pyTo) get(s[2]).salesPY += s[4];
  }
  const rows = [];
  for (let pi = 0; pi < M.partners.length; pi++) {
    const p = M.partners[pi];
    const f = fact.get(pi);
    const planIdx = M.planByPartner[pi];
    if (!f && !planIdx.length) continue;
    let plan = 0,
      planPeriod = 0;
    const segs = new Set();
    for (const i of planIdx) {
      const r = M.planRows[i];
      plan += r.sum;
      if (r.ym >= P.from && r.ym <= P.to) planPeriod += r.sum;
      const seg = clean(r.a6);
      if (seg) segs.add(seg);
    }
    const sales = f?.sales ?? 0;
    const hasPlan = planIdx.length > 0;
    rows.push({
      code: f ? p.code : null,
      id: f ? p.code : `name:${p.name}`,
      name: p.name,
      rm: hasPlan ? clean(p.rm) : '',
      tm: hasPlan ? clean(p.tm) : '',
      region: hasPlan ? clean(p.t2) : '',
      segments: sortRu(segs),
      sales,
      profit: f?.profit ?? 0,
      salesPY: f?.salesPY ?? 0,
      qty: f?.qty ?? 0,
      plan,
      planPeriod,
      execPct: hasPlan && planPeriod > 0 ? (sales / planPeriod) * 100 : null,
      hasPlan,
      hasFact: !!f,
    });
  }
  // as in the OLAP version: by period plan, else by annual plan, else by sales
  rows.sort((a, b) => (b.planPeriod || b.plan || b.sales) - (a.planPeriod || a.plan || a.sales));
  return {
    rows,
    meta: {
      planYear: PLAN_YEAR,
      from: ymKey(P.from),
      to: ymKey(P.to),
      totalSales: rows.reduce((t, r) => t + r.sales, 0),
      totalPlan: rows.reduce((t, r) => t + r.plan, 0),
      totalPlanPeriod: rows.reduce((t, r) => t + r.planPeriod, 0),
      partners: rows.length,
      withPlan: rows.filter(r => r.hasPlan).length,
    },
    olapError: null,
  };
}

// ══════ purchase mix by brand within the comparison scope ══════
const STRUCT_SCOPES = new Set(['dept', 'terr1', 'terr2']);
export async function getCustomerStructure(scope, unit, from, to) {
  if (!STRUCT_SCOPES.has(scope) || !unit) return null;
  const M = getDemoModel();
  const P = period(M, from, to);
  const byBrand = new Map();
  for (const s of M.sales) {
    if (s[3] < P.from || s[3] > P.to) continue;
    const p = M.partners[s[2]];
    const v = scope === 'dept' ? M.depts[s[1]].name : scope === 'terr1' ? p.t1 : p.t2;
    if (v !== unit) continue;
    const b = M.items[s[0]].brand;
    byBrand.set(b, (byBrand.get(b) || 0) + s[4]);
  }
  const list = Array.from(byBrand, ([brand, rev]) => ({ brand, rev }))
    .filter(b => b.rev > 0)
    .sort((a, b) => b.rev - a.rev);
  const total = list.reduce((t, b) => t + b.rev, 0);
  return { scope, unit, total, brands: list.map(b => ({ ...b, share: total > 0 ? b.rev / total : 0 })) };
}

// ══════ client card ══════
function passportOf(M, pi) {
  const p = M.partners[pi];
  const r = rng(hash32('passport', p.code));
  const h = hash32('guid', p.code).toString(16).padStart(8, '0');
  const typical = Math.max(recentMonthly(M, pi), p.size * 0.4);
  const limitEnabled = r.chance(0.6);
  const active = !p.end && !p.planOnly;
  return {
    code: p.code,
    name: p.name,
    guid: `${h}-${h.slice(0, 4)}-4${h.slice(1, 4)}-a${h.slice(5, 8)}-${h}${h.slice(0, 4)}`,
    businessRegion: clean(p.t1) || null,
    ritBusinessRegion: clean(p.t2) || null,
    deliveryZone: p.deliveryZone || null,
    classifier: p.classifier || null,
    entityKind: p.entity || null,
    status: active ? 'Действующий' : 'Не работаем',
    debtLimit: limitEnabled ? Math.round((typical * r.uni(1.0, 1.9)) / 1000) * 1000 : null,
    limitEnabled,
    blockOnOverdue: r.chance(0.4),
  };
}

function standingOf(M, pi, P) {
  const rev = new Map();
  for (const s of M.sales) if (s[3] >= P.from && s[3] <= P.to) rev.set(s[2], (rev.get(s[2]) || 0) + s[4]);
  const list = Array.from(rev, ([p, v]) => ({ p, v }))
    .filter(x => x.v > 0)
    .sort((a, b) => b.v - a.v);
  if (!list.length) return { companySales: 0, rank: 0, partners: 0, share: 0, abc: null };
  const companySales = list.reduce((t, x) => t + x.v, 0);
  const idx = list.findIndex(x => x.p === pi);
  if (idx < 0) return { companySales, rank: 0, partners: list.length, share: 0, abc: null };
  let cum = 0;
  for (let i = 0; i <= idx; i++) cum += list[i].v;
  const cumShare = cum / companySales;
  return {
    companySales,
    rank: idx + 1,
    partners: list.length,
    share: list[idx].v / companySales,
    abc: cumShare <= 0.8 ? 'A' : cumShare <= 0.95 ? 'B' : 'C',
  };
}

function unshippedOf(M, pi) {
  const p = M.partners[pi];
  const asOf = asOfDate(M);
  const r = rng(hash32('unshipped', p.code));
  const recentFrom = ymAdd(M.lastYM, -1);
  const recent = new Map(); // item → qty over 2 months
  for (const i of M.salesByPartner[pi]) {
    const s = M.sales[i];
    if (s[3] >= recentFrom) recent.set(s[0], (recent.get(s[0]) || 0) + s[5]);
  }
  const items = [];
  if (recent.size && r.chance(0.45)) {
    const pool = Array.from(recent.keys());
    const n = Math.min(pool.length, r.int(2, 12));
    for (let k = 0; k < n; k++) {
      const j = k + Math.floor(r.next() * (pool.length - k));
      [pool[k], pool[j]] = [pool[j], pool[k]];
      const it = M.items[pool[k]];
      const qty = Math.max(1, Math.round((recent.get(it.id) / 2) * r.uni(0.1, 0.5)));
      const sum = Math.round(qty * it.price0 * it.priceIdx[Math.floor(M.lastYM / 100)] * (1 - p.disc));
      const a = itemAttrs(it);
      items.push({ code: a.code, name: a.name, brand: a.brand, group: a.group, kind: a.kind, sum, qty });
    }
    items.sort((a, b) => b.sum - a.sum);
  }
  return { items, totalSum: items.reduce((t, x) => t + x.sum, 0), totalQty: items.reduce((t, x) => t + x.qty, 0), asOf };
}

const DEBT_INTERVALS = ['1-7 дней', '8-15 дней', '16-30 дней', '31-60 дней', '61-90 дней', 'Свыше 90 дней'];
function debtOf(M, pi, unshipped) {
  const p = M.partners[pi];
  const r = rng(hash32('debt', p.code));
  const monthly = recentMonthly(M, pi);
  const churned = !!p.end;
  let total;
  let overdueShare;
  if (churned) {
    // churned client: residual debt, fully overdue (or no debt)
    total = r.chance(0.5) ? Math.round(p.size * r.uni(0.05, 0.25)) : 0;
    overdueShare = 1;
  } else {
    total = Math.round(monthly * r.uni(0.5, 1.6));
    const x = r.next();
    overdueShare = x < 0.62 ? 0 : x < 0.88 ? r.uni(0.03, 0.12) : r.uni(0.2, 0.6);
  }
  const overdue = Math.round(total * overdueShare);
  const intervals = [];
  if (total > overdue) intervals.push({ interval: 'Не просрочено', num: 0, debt: total - overdue, overdue: 0 });
  if (overdue > 0) {
    const w = churned ? [0, 0, 0.05, 0.15, 0.3, 0.5] : [0.4, 0.25, 0.18, 0.1, 0.05, 0.02];
    let left = overdue;
    w.forEach((wi, k) => {
      const v = k === w.length - 1 ? left : Math.round(overdue * wi);
      left -= v;
      if (v > 0) intervals.push({ interval: DEBT_INTERVALS[k], num: k + 1, debt: v, overdue: v });
    });
  }
  return {
    asOf: asOfDate(M),
    total,
    overdue,
    ourDebt: r.chance(0.1) ? Math.round(monthly * r.uni(0.02, 0.1)) : 0,
    toShip: unshipped.totalSum,
    plannedShip: Math.round(unshipped.totalSum * r.uni(0.6, 1)),
    intervals,
  };
}

export async function getCustomerProfile(id, from, to) {
  const M = getDemoModel();
  const pi = id.startsWith('name:') ? partnerByName(M).get(id.slice(5)) : partnerByCode(M).get(id);
  if (pi === undefined) return null;
  const p = M.partners[pi];
  const P = period(M, from, to);
  const byName = id.startsWith('name:');
  const passport = byName
    ? {
        code: null, name: p.name, guid: null, businessRegion: null, ritBusinessRegion: null, deliveryZone: null,
        classifier: null, entityKind: null, status: null, debtLimit: null, limitEnabled: false, blockOnOverdue: false,
      }
    : passportOf(M, pi);

  // sales by SKU × month, prior year, churn
  const cur = new Map();
  const py = new Map();
  const depts = new Map();
  const freqRev = new Map();
  const freqRows = new Map();
  for (const i of M.salesByPartner[pi]) {
    const s = M.sales[i];
    const it = M.items[s[0]];
    if (s[3] >= P.from && s[3] <= P.to) {
      let e = cur.get(it.id);
      if (!e) cur.set(it.id, (e = { ...itemAttrs(it), months: new Map(), revPrev: 0, qtyPrev: 0, isNew: false }));
      const mk = ymKey(s[3]);
      const m = e.months.get(mk) || { month: mk, qty: 0, rev: 0, profit: 0, opr: 0 };
      m.qty += s[5];
      m.rev += s[4];
      m.profit += s[4] * it.margin;
      m.opr += s[4] * p.oprRate;
      e.months.set(mk, m);
      const dn = M.depts[s[1]].name;
      const d = depts.get(dn) || { name: dn, revenue: 0, qty: 0 };
      d.revenue += s[4];
      d.qty += s[5];
      depts.set(dn, d);
      freqRev.set(s[3], (freqRev.get(s[3]) || 0) + s[4]);
      freqRows.set(s[3], (freqRows.get(s[3]) || 0) + 1);
    } else if (s[3] >= P.pyFrom && s[3] <= P.pyTo) {
      const e = py.get(it.id) || { ...itemAttrs(it), revPrev: 0, qtyPrev: 0 };
      e.revPrev += s[4];
      e.qtyPrev += s[5];
      py.set(it.id, e);
    }
  }
  const churn = [];
  for (const [itId, e] of py) {
    if (cur.has(itId)) {
      cur.get(itId).revPrev = e.revPrev;
      cur.get(itId).qtyPrev = e.qtyPrev;
    } else churn.push(e);
  }
  const sumRev = e => e.months.reduce((t, m) => t + m.rev, 0);
  const salesItems = Array.from(cur.values())
    .map(e => ({ ...e, months: Array.from(e.months.values()).sort((a, b) => a.month.localeCompare(b.month)) }))
    .sort((a, b) => sumRev(b) - sumRev(a));
  churn.sort((a, b) => b.revPrev - a.revPrev);

  // client plan — for the whole plan year, as in the OLAP version
  const planByMonth = {};
  let planTotal = 0;
  const segments = new Set();
  for (const i of M.planByPartner[pi]) {
    const r = M.planRows[i];
    planTotal += r.sum;
    const mk = ymKey(r.ym);
    planByMonth[mk] = (planByMonth[mk] ?? 0) + r.sum;
    const seg = clean(r.a6);
    if (seg) segments.add(seg);
  }
  const hasPlan = M.planByPartner[pi].length > 0;

  // unfulfilled demand by SKU × month (raw, like the cube measure)
  const defMap = new Map();
  for (const i of M.defectByPartner[pi]) {
    const d = M.defect[i];
    if (d[3] < P.from || d[3] > P.to) continue;
    const it = M.items[d[0]];
    let e = defMap.get(it.id);
    if (!e) defMap.set(it.id, (e = { ...itemAttrs(it), months: new Map() }));
    const mk = ymKey(d[3]);
    const m = e.months.get(mk) || { month: mk, sum: 0, qty: 0 };
    m.sum += d[5];
    m.qty += d[4];
    e.months.set(mk, m);
  }
  const defectItems = Array.from(defMap.values())
    .map(e => ({ ...e, months: Array.from(e.months.values()).sort((a, b) => a.month.localeCompare(b.month)) }))
    .sort((a, b) => b.months.reduce((t, m) => t + m.sum, 0) - a.months.reduce((t, m) => t + m.sum, 0));

  const unshipped = byName ? { items: [], totalSum: 0, totalQty: 0, asOf: asOfDate(M) } : unshippedOf(M, pi);
  const debt = byName
    ? { asOf: asOfDate(M), total: 0, overdue: 0, ourDebt: 0, toShip: 0, plannedShip: 0, intervals: [] }
    : debtOf(M, pi, unshipped);

  // links: managers from orders (sometimes a manager change within the period), departments, order frequency
  const totalRev = Array.from(depts.values()).reduce((t, d) => t + d.revenue, 0);
  const totalQty = Array.from(depts.values()).reduce((t, d) => t + d.qty, 0);
  const r = rng(hash32('bindings', p.code));
  const split = (main, alt) => {
    if (!totalRev) return [];
    const mainName = clean(main) || '— не указан —';
    if (!alt || alt === main || !r.chance(0.2)) return [{ name: mainName, revenue: totalRev, qty: totalQty }];
    const k = r.uni(0.1, 0.3);
    return [
      { name: mainName, revenue: totalRev * (1 - k), qty: Math.round(totalQty * (1 - k)) },
      { name: alt, revenue: totalRev * k, qty: totalQty - Math.round(totalQty * (1 - k)) },
    ];
  };
  const others = (field, self) => {
    const vals = Array.from(new Set(M.partners.map(x => x[field]).filter(v => v && v !== self))).sort(ru);
    return vals.length ? vals[hash32(field, p.code) % vals.length] : null;
  };
  const perOrder = p.key || p.kind === 'market' ? 5 : p.kind === 'distr' || p.kind === 'chain' ? 8 : 6;
  const freq = Array.from(freqRev.keys())
    .sort((a, b) => a - b)
    .map(ym => ({
      month: ymKey(ym),
      orders: Math.max(1, Math.round((freqRows.get(ym) / perOrder) * (0.8 + 0.4 * rng(hash32('orders', p.code, ym)).next()))),
      revenue: freqRev.get(ym),
    }));
  const hasSales = totalRev > 0;

  return {
    passport,
    period: { from: ymKey(P.from), to: ymKey(P.to) },
    planYear: PLAN_YEAR,
    standing: standingOf(M, pi, P),
    novelty: { available: false, count: 0, revenue: 0, share: 0 },
    salesItems,
    churn,
    planByMonth,
    planTotal,
    defect: { items: defectItems },
    unshipped,
    debt,
    bindings: {
      rm: split(p.rm, others('rm', p.rm)),
      tm: p.tm ? split(p.tm, others('tm', p.tm)) : split(null, null),
      op: hasSales ? [{ name: p.op, revenue: totalRev, qty: totalQty }] : [],
      depts: Array.from(depts.values()).sort((a, b) => b.revenue - a.revenue),
      planRm: hasPlan && clean(p.rm) ? [p.rm] : [],
      planTm: hasPlan && clean(p.tm) ? [p.tm] : [],
      regionsPlan: hasPlan && clean(p.t2) ? [p.t2] : [],
      segments: sortRu(segments),
      terrRegion: hasSales ? clean(p.t1) : '',
      terrTerritory: hasSales ? clean(p.t2) : '',
      freq,
      priceTypesAvailable: false,
    },
    olapError: null,
  };
}
