// "Client agent" for DATA_SOURCE=olap: client profile from the OLAP cube.
// Base prices come from the DWH (dwhClient.js). The "new product" flag is not populated (the tab
// does not show it). The demo counterpart with identical responses is src/demo/customerService.js.
import { dax, daxStr } from '../olapClient.js';
import { fetchBasePrices, dwhConfigured } from '../dwhClient.js';
import { PLAN_ARTICLE, PLAN_YEAR } from '../report/reportConfig.js';
// Customer profile business logic (/profiles/customer).
//
// Idea: not a dashboard slice but a card for ONE client that gathers everything known about it —
// sales, sales plan, unfulfilled demand, unshipped orders, receivables (total/overdue) and
// "bindings" (managers, territories/regions, departments, order frequency).
//
// SOURCE — the OLAP cube only, queried live via olapClient.js.
// All facts are related to the 'Спр - Партнеры' (partners) dimension:
//   • Sales/revenue/profit      — 'Факт - Валовая прибыль'  (# Выручка / # Количество / # Валовая прибыль)
//   • Unfulfilled demand        — 'Факт - Дефектура'        (# Дефектура на сумму / # Дефектура, шт.)
//   • Unshipped orders          — 'Факт - Неотгруженные заказы клиентам'
//   • Receivables (total/overdue) — 'Факт - Задолженность клиентов по срокам долга' (SEMI-ADDITIVE!)
//   • Sales plan                — 'Факт - План Факт', budget item PLAN_ARTICLE (reportConfig.js)
//   • Managers/departments      — 'Спр - ... из заказов' / 'Спр - Структура предприятия' dimensions
//
// ⚠️ The plan "by client, regional manager, territorial manager" lives in generic text columns of
//   the plan/actual fact: Аналитика 1 = regional manager (RM), Аналитика 2 = territorial manager
//   (TM), Аналитика 3 = region/territory, Аналитика 4 = CLIENT (partner name), Аналитика 6 = plan
//   segment (Захват/Удержание/Регулярный ассортимент). Amount in ₽ (scenario quantity is empty).
//   The fact has NO partner FK — plan is joined to actuals BY (normalised) CLIENT NAME.
//
// ⚠️ RECEIVABLES ARE SEMI-ADDITIVE over 'Дата отчета' (report date) — without pinning the date the
//   measures are wrong (they sum all snapshots). So receivables are read strictly on the LATEST
//   report date (see loadDebtDate).
//
// ⚠️ The cube has NO PRICE TYPES: 'Спр - Договоры'[Вид цен продажи/учетный] is empty, and in the ERP
//   they live on an object that is not exposed. The section returns priceTypesAvailable=false.
//
// Cube history starts in FIRST_YEAR, the plan is for PLAN_YEAR. The cube may be unavailable
// (network/processing) — sections catch the error and return empty data with an olapError flag,
// while the profile still opens.
const num = v => (v === null || v === undefined ? 0 : Number(v) || 0);
const s = v => String(v ?? '').trim();
/** Maps "not specified"/technical plan values to an empty string. */
const clean = v => {
  const t = s(v);
  if (!t || t === 'Неизвестно' || t === 'Без РМ' || t === 'Без ТМ' || t.startsWith('<')) return '';
  return t;
};
/** Normalises a client name for plan↔actual matching (case, whitespace, ё→е, quotes). */
const normName = v =>
  s(v)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`]/g, '')
    .split(/\s+/)
    .join(' ');
export function makePeriod(from, to) {
  const parse = (str, fb) => {
    const m = /^(\d{4})-(\d{2})$/.exec(str ?? '');
    return m ? { y: Number(m[1]), m: Number(m[2]) } : fb;
  };
  const now = new Date();
  const a = parse(from, { y: PLAN_YEAR, m: 1 });
  const b = parse(to, { y: now.getFullYear(), m: now.getMonth() + 1 });
  const next = b.m === 12 ? { y: b.y + 1, m: 1 } : { y: b.y, m: b.m + 1 };
  return {
    fromY: a.y,
    fromM: a.m,
    toY: b.y,
    toM: b.m,
    fromDax: `DATE(${a.y},${a.m},1)`,
    toDaxExcl: `DATE(${next.y},${next.m},1)`,
  };
}
const periodFilter = p =>
  `FILTER(ALL('Спр - Календарь'[Дата]),'Спр - Календарь'[Дата]>=${p.fromDax} && 'Спр - Календарь'[Дата]<${p.toDaxExcl})`;
/** Period filter by explicit year/month (needed for the same period of the prior year). */
const periodFilterYM = (fy, fm, ty, tm) => {
  const [ny, nm] = tm === 12 ? [ty + 1, 1] : [ty, tm + 1];
  return `FILTER(ALL('Спр - Календарь'[Дата]),'Спр - Календарь'[Дата]>=DATE(${fy},${fm},1) && 'Спр - Календарь'[Дата]<DATE(${ny},${nm},1))`;
};
/** Filter by a single partner: by code (reliable) or by name (for plan-only clients). */
const partnerFilter = (code, name) =>
  code
    ? `FILTER(ALL('Спр - Партнеры'[Код]),'Спр - Партнеры'[Код]=${daxStr(code)})`
    : `FILTER(ALL('Спр - Партнеры'[Партнер]),'Спр - Партнеры'[Партнер]=${daxStr(name)})`;
const planArticleFilter = () =>
  `FILTER(ALL('Факт - План Факт'[Статья бюджетов]),'Факт - План Факт'[Статья бюджетов]=${daxStr(PLAN_ARTICLE)})`;
const monthKey = (year, monthNo) => `${Number(year)}-${String(Number(monthNo)).padStart(2, '0')}`;
const pad2 = n => String(n).padStart(2, '0');
/**
 * Lenient cube date parsing. msmdpump/XMLA returns ISO "2026-06-01T00:00:00",
 * while an MSOLAP runner returns a localised "01.06.2026 0:00:00". Both are supported.
 */
const parseCubeDate = v => {
  const str = s(v);
  let mm = str.match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO
  if (mm) return { y: +mm[1], m: +mm[2], d: +mm[3] };
  mm = str.match(/^(\d{2})\.(\d{2})\.(\d{4})/); // DD.MM.YYYY
  if (mm) return { y: +mm[3], m: +mm[2], d: +mm[1] };
  return null;
};
/** Cube date → "2026-06" (year-month). */
const planMonthKey = v => {
  const d = parseCubeDate(v);
  return d ? `${d.y}-${pad2(d.m)}` : null;
};
const OVERVIEW_TTL = 30 * 60 * 1000;
const overviewCache = new Map();
export async function getCustomerOverview(from, to) {
  const p = makePeriod(from ?? `${PLAN_YEAR}-01`, to ?? '');
  const fromKey = `${p.fromY}-${pad2(p.fromM)}`;
  const toKey = `${p.toY}-${pad2(p.toM)}`;
  const cacheKey = `${fromKey}|${toKey}`;
  const hit = overviewCache.get(cacheKey);
  if (hit && Date.now() - hit.at < OVERVIEW_TTL) return hit.data;
  let olapError = null;
  let factNow = [];
  let factPY = [];
  let planRows = [];
  let planMonthRows = [];
  try {
    [factNow, factPY, planRows, planMonthRows] = await Promise.all([
      dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Партнеры'[Код], 'Спр - Партнеры'[Партнер],
  ${periodFilterYM(p.fromY, p.fromM, p.toY, p.toM)},
  "rev", [# Выручка], "qty", [# Количество], "profit", [# Валовая прибыль]
)`),
      dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Партнеры'[Код], 'Спр - Партнеры'[Партнер],
  ${periodFilterYM(p.fromY - 1, p.fromM, p.toY - 1, p.toM)},
  "rev", [# Выручка]
)`),
      dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Факт - План Факт'[Аналитика 4], 'Факт - План Факт'[Аналитика 1],
  'Факт - План Факт'[Аналитика 2], 'Факт - План Факт'[Аналитика 3], 'Факт - План Факт'[Аналитика 6],
  ${planArticleFilter()},
  "plan", [# Сумма сценария]
)`),
      dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Факт - План Факт'[Аналитика 4], 'Факт - План Факт'[Месяц отчетного периода],
  ${planArticleFilter()},
  "plan", [# Сумма сценария]
)`),
    ]);
  } catch (e) {
    olapError = String(e?.message ?? e).slice(0, 300);
    console.error('[profiles/customer] overview: cube unavailable:', olapError);
  }
  const byCode = new Map();
  const getF = (code, name) => {
    const key = code || `~${name}`;
    if (!byCode.has(key)) byCode.set(key, { code, name, sales: 0, profit: 0, salesPY: 0, qty: 0 });
    return byCode.get(key);
  };
  for (const r of factNow) {
    const a = getF(s(r['Спр - Партнеры[Код]']), s(r['Спр - Партнеры[Партнер]']) || '— не указан —');
    a.sales += num(r['[rev]']);
    a.qty += num(r['[qty]']);
    a.profit += num(r['[profit]']);
  }
  for (const r of factPY) {
    const a = getF(s(r['Спр - Партнеры[Код]']), s(r['Спр - Партнеры[Партнер]']) || '— не указан —');
    a.salesPY += num(r['[rev]']);
  }
  // Period plan per client (Аналитика 4): sum of plan months within [from..to].
  const planPeriodByNorm = new Map();
  for (const r of planMonthRows) {
    const name = clean(r['Факт - План Факт[Аналитика 4]']);
    if (!name) continue;
    const mk = planMonthKey(r['Факт - План Факт[Месяц отчетного периода]']);
    if (!mk || mk < fromKey || mk > toKey) continue;
    const key = normName(name);
    planPeriodByNorm.set(key, (planPeriodByNorm.get(key) ?? 0) + num(r['[plan]']));
  }
  const byPlanName = new Map();
  for (const r of planRows) {
    const name = clean(r['Факт - План Факт[Аналитика 4]']);
    if (!name) continue;
    const key = normName(name);
    if (!byPlanName.has(key))
      byPlanName.set(key, {
        name,
        plan: 0,
        rm: new Map(),
        tm: new Map(),
        region: new Map(),
        segs: new Set(),
      });
    const a = byPlanName.get(key);
    const v = num(r['[plan]']);
    a.plan += v;
    const bump = (m, val) => {
      if (val) m.set(val, (m.get(val) ?? 0) + v);
    };
    bump(a.rm, clean(r['Факт - План Факт[Аналитика 1]']));
    bump(a.tm, clean(r['Факт - План Факт[Аналитика 2]']));
    bump(a.region, clean(r['Факт - План Факт[Аналитика 3]']));
    const seg = clean(r['Факт - План Факт[Аналитика 6]']);
    if (seg) a.segs.add(seg);
  }
  const topOf = m => {
    let best = '',
      bv = -1;
    m.forEach((v, k) => {
      if (v > bv) {
        bv = v;
        best = k;
      }
    });
    return best;
  };
  // Join actuals↔plan by normalised name.
  const factByNorm = new Map();
  for (const f of Array.from(byCode.values())) factByNorm.set(normName(f.name), f);
  const rows = [];
  const usedFact = new Set();
  // 1) all plan clients (with actuals if found)
  for (const [key, pl] of Array.from(byPlanName.entries())) {
    const f = factByNorm.get(key);
    if (f) usedFact.add(key);
    const sales = f?.sales ?? 0;
    const planPeriod = planPeriodByNorm.get(key) ?? 0;
    rows.push({
      code: f?.code || null,
      id: f?.code || `name:${pl.name}`,
      name: f?.name || pl.name,
      rm: topOf(pl.rm),
      tm: topOf(pl.tm),
      region: topOf(pl.region),
      segments: Array.from(pl.segs).sort((a, b) => a.localeCompare(b, 'ru')),
      sales,
      profit: f?.profit ?? 0,
      salesPY: f?.salesPY ?? 0,
      qty: f?.qty ?? 0,
      plan: pl.plan,
      planPeriod,
      execPct: planPeriod > 0 ? (sales / planPeriod) * 100 : null,
      hasPlan: true,
      hasFact: !!f,
    });
  }
  // 2) partners with actuals but no plan
  for (const [key, f] of Array.from(factByNorm.entries())) {
    if (usedFact.has(key)) continue;
    rows.push({
      code: f.code || null,
      id: f.code || `name:${f.name}`,
      name: f.name,
      rm: '',
      tm: '',
      region: '',
      segments: [],
      sales: f.sales,
      profit: f.profit,
      salesPY: f.salesPY,
      qty: f.qty,
      plan: 0,
      planPeriod: 0,
      execPct: null,
      hasPlan: false,
      hasFact: true,
    });
  }
  rows.sort((a, b) => (b.planPeriod || b.plan || b.sales) - (a.planPeriod || a.plan || a.sales));
  const data = {
    rows,
    meta: {
      planYear: PLAN_YEAR,
      from: fromKey,
      to: toKey,
      totalSales: rows.reduce((t, r) => t + r.sales, 0),
      totalPlan: rows.reduce((t, r) => t + r.plan, 0),
      totalPlanPeriod: rows.reduce((t, r) => t + r.planPeriod, 0),
      partners: rows.length,
      withPlan: rows.filter(r => r.hasPlan).length,
    },
    olapError,
  };
  if (!olapError) overviewCache.set(cacheKey, { at: Date.now(), data });
  return data;
}
const PROFILE_TTL = 5 * 60 * 1000;
const profileCache = new Map();
/** Parses a card id: ERP code or "name:<name>" (plan-only client). */
function parseId(id) {
  if (id.startsWith('name:')) return { code: null, name: id.slice(5) };
  return { code: id, name: '' };
}
const truthy = v => {
  const t = s(v).toLowerCase();
  return t === 'да' || t === 'true' || t === '1' || t === 'истина';
};
async function loadPassport(code, name) {
  const empty = { debtLimit: null, limitEnabled: false, blockOnOverdue: false };
  if (!code)
    return {
      code: null,
      name,
      guid: null,
      businessRegion: null,
      ritBusinessRegion: null,
      deliveryZone: null,
      classifier: null,
      entityKind: null,
      status: null,
      ...empty,
    };
  const rows = await dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Партнеры'[Код], 'Спр - Партнеры'[Партнер], 'Спр - Партнеры'[Бизнес-регион],
  'Спр - Партнеры'[(рит) Бизнес регион], 'Спр - Партнеры'[Зона доставки],
  'Спр - Партнеры'[Классификатор контрагентов], 'Спр - Партнеры'[Юр/Физлицо],
  'Спр - Партнеры'[Статус], 'Спр - Партнеры'[Бизнес-ключ (GUID/Ref из 1С)],
  'Спр - Партнеры'[Допустимая сумма задолженности],
  'Спр - Партнеры'[Ограничивать сумму задолженности],
  'Спр - Партнеры'[Запрещается отгрузка при просроченной задолженности],
  ${partnerFilter(code, name)}
)`);
  if (!rows.length) return null;
  const r = rows[0];
  const lim = num(r['Спр - Партнеры[Допустимая сумма задолженности]']);
  return {
    code,
    name: s(r['Спр - Партнеры[Партнер]']) || name,
    guid: s(r['Спр - Партнеры[Бизнес-ключ (GUID/Ref из 1С)]']) || null,
    businessRegion: clean(r['Спр - Партнеры[Бизнес-регион]']) || null,
    ritBusinessRegion: clean(r['Спр - Партнеры[(рит) Бизнес регион]']) || null,
    deliveryZone: clean(r['Спр - Партнеры[Зона доставки]']) || null,
    classifier: clean(r['Спр - Партнеры[Классификатор контрагентов]']) || null,
    entityKind: clean(r['Спр - Партнеры[Юр/Физлицо]']) || null,
    status: clean(r['Спр - Партнеры[Статус]']) || null,
    debtLimit: lim > 0 ? lim : null,
    limitEnabled: truthy(r['Спр - Партнеры[Ограничивать сумму задолженности]']),
    blockOnOverdue: truthy(r['Спр - Партнеры[Запрещается отгрузка при просроченной задолженности]']),
  };
}
/** Client standing in the company for the period: revenue share, rank, ABC (A≤80%, B≤95%, C — tail). */
async function loadStanding(code, name, p) {
  const empty = { companySales: 0, rank: 0, partners: 0, share: 0, abc: null };
  const rows = await dax(`
EVALUATE
SUMMARIZECOLUMNS('Спр - Партнеры'[Код], ${periodFilter(p)}, "rev", [# Выручка])`);
  const list = rows
    .map(r => ({ code: s(r['Спр - Партнеры[Код]']), rev: num(r['[rev]']) }))
    .filter(r => r.rev > 0)
    .sort((a, b) => b.rev - a.rev);
  if (!list.length) return empty;
  const companySales = list.reduce((t, r) => t + r.rev, 0);
  const idx = list.findIndex(r => (code ? r.code === code : false));
  if (idx < 0) return { companySales, rank: 0, partners: list.length, share: 0, abc: null };
  // ABC by cumulative share up to and including this client.
  let cum = 0;
  for (let i = 0; i <= idx; i++) cum += list[i].rev;
  const cumShare = cum / companySales;
  const abc = cumShare <= 0.8 ? 'A' : cumShare <= 0.95 ? 'B' : 'C';
  return { companySales, rank: idx + 1, partners: list.length, share: list[idx].rev / companySales, abc };
}
/** Sales by SKU × month (+ trade spend, + prior-year per item) and the list of fully dropped items (churn). */
async function loadSalesItems(code, name, p, noveltyIds) {
  const pyFilter = periodFilterYM(p.fromY - 1, p.fromM, p.toY - 1, p.toM);
  const [rows, pyRows] = await Promise.all([
    dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Номенклатура'[Код], 'Спр - Номенклатура'[Номенклатура], 'Спр - Номенклатура'[Бренд],
  'Спр - Номенклатура'[Товарная группа], 'Спр - Виды номенклатуры'[Вид номенклатуры],
  'Спр - Номенклатура объединенная'[Код],
  'Спр - Календарь'[Год], 'Спр - Календарь'[Порядковый номер Месяца],
  ${partnerFilter(code, name)}, ${periodFilter(p)},
  "rev", [# Выручка], "qty", [# Количество], "profit", [# Валовая прибыль], "opr", [# Сумма ОПР]
)`),
    dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Номенклатура'[Код], 'Спр - Номенклатура'[Номенклатура], 'Спр - Номенклатура'[Бренд],
  'Спр - Номенклатура'[Товарная группа], 'Спр - Виды номенклатуры'[Вид номенклатуры],
  ${partnerFilter(code, name)}, ${pyFilter},
  "rev", [# Выручка], "qty", [# Количество]
)`),
  ]);
  const attrs = (r, sku) => ({
    code: sku,
    name: s(r['Спр - Номенклатура[Номенклатура]']) || sku,
    brand: clean(r['Спр - Номенклатура[Бренд]']) || '— без марки —',
    group: clean(r['Спр - Номенклатура[Товарная группа]']) || '— без группы —',
    kind: clean(r['Спр - Виды номенклатуры[Вид номенклатуры]']) || '— не указан —',
  });
  const pyBy = new Map();
  for (const r of pyRows) {
    const sku = s(r['Спр - Номенклатура[Код]']);
    if (!sku) continue;
    const rev = num(r['[rev]']),
      qty = num(r['[qty]']);
    if (rev === 0 && qty === 0) continue;
    pyBy.set(sku, { rev, qty, a: attrs(r, sku) });
  }
  const bySku = new Map();
  for (const r of rows) {
    const sku = s(r['Спр - Номенклатура[Код]']);
    if (!sku) continue;
    if (!bySku.has(sku)) {
      const mc = s(r['Спр - Номенклатура объединенная[Код]']);
      bySku.set(sku, { ...attrs(r, sku), months: [], revPrev: 0, qtyPrev: 0, isNew: noveltyIds.has(mc) });
    }
    const rev = num(r['[rev]']),
      qty = num(r['[qty]']);
    if (rev === 0 && qty === 0) continue;
    bySku.get(sku).months.push({
      month: monthKey(r['Спр - Календарь[Год]'], r['Спр - Календарь[Порядковый номер Месяца]']),
      qty,
      rev,
      profit: num(r['[profit]']),
      opr: num(r['[opr]']),
    });
  }
  // Attach prior-year values to current items; dropped items (sold last year, not now) go to churn.
  const churn = [];
  for (const [sku, py] of Array.from(pyBy.entries())) {
    if (bySku.has(sku)) {
      const it = bySku.get(sku);
      it.revPrev = py.rev;
      it.qtyPrev = py.qty;
    } else churn.push({ ...py.a, revPrev: py.rev, qtyPrev: py.qty });
  }
  const items = Array.from(bySku.values())
    .filter(it => it.months.length)
    .map(it => ({ ...it, months: it.months.sort((a, b) => a.month.localeCompare(b.month)) }))
    .sort((a, b) => b.months.reduce((t, m) => t + m.rev, 0) - a.months.reduce((t, m) => t + m.rev, 0));
  churn.sort((a, b) => b.revPrev - a.revPrev);
  return { items, churn };
}
async function loadPlanMonths(name) {
  if (!name) return { byMonth: {}, total: 0 };
  const rows = await dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Факт - План Факт'[Месяц отчетного периода],
  ${planArticleFilter()},
  FILTER(ALL('Факт - План Факт'[Аналитика 4]),'Факт - План Факт'[Аналитика 4]=${daxStr(name)}),
  "plan", [# Сумма сценария]
)`);
  const byMonth = {};
  let total = 0;
  for (const r of rows) {
    const v = num(r['[plan]']);
    total += v; // always count the total, even if the month is not recognised
    const mk = planMonthKey(r['Факт - План Факт[Месяц отчетного периода]']);
    if (mk) byMonth[mk] = (byMonth[mk] ?? 0) + v;
  }
  return { byMonth, total };
}
/** Unfulfilled demand by SKU × month (+ attributes for the product filter). */
async function loadDefectItems(code, name, p) {
  const rows = await dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Номенклатура'[Код], 'Спр - Номенклатура'[Номенклатура], 'Спр - Номенклатура'[Бренд],
  'Спр - Номенклатура'[Товарная группа], 'Спр - Виды номенклатуры'[Вид номенклатуры],
  'Спр - Календарь'[Год], 'Спр - Календарь'[Порядковый номер Месяца],
  ${partnerFilter(code, name)}, ${periodFilter(p)},
  "ds", [# Дефектура на сумму], "dq", [# Дефектура, шт.]
)`);
  const bySku = new Map();
  for (const r of rows) {
    const sku = s(r['Спр - Номенклатура[Код]']);
    if (!sku) continue;
    if (!bySku.has(sku))
      bySku.set(sku, {
        code: sku,
        name: s(r['Спр - Номенклатура[Номенклатура]']) || sku,
        brand: clean(r['Спр - Номенклатура[Бренд]']) || '— без марки —',
        group: clean(r['Спр - Номенклатура[Товарная группа]']) || '— без группы —',
        kind: clean(r['Спр - Виды номенклатуры[Вид номенклатуры]']) || '— не указан —',
        months: [],
      });
    const sum = num(r['[ds]']),
      qty = num(r['[dq]']);
    if (sum === 0 && qty === 0) continue;
    bySku.get(sku).months.push({
      month: monthKey(r['Спр - Календарь[Год]'], r['Спр - Календарь[Порядковый номер Месяца]']),
      sum,
      qty,
    });
  }
  return Array.from(bySku.values())
    .filter(it => it.months.length)
    .map(it => ({ ...it, months: it.months.sort((a, b) => a.month.localeCompare(b.month)) }))
    .sort((a, b) => b.months.reduce((t, m) => t + m.sum, 0) - a.months.reduce((t, m) => t + m.sum, 0));
}
/** Latest snapshot date of unshipped orders (daily snapshot). */
async function loadUnshippedDate() {
  try {
    const rows = await dax(
      `EVALUATE ROW("d", CALCULATE(MAX('Спр - Календарь'[Дата]), 'Факт - Неотгруженные заказы клиентам'))`,
    );
    const d = parseCubeDate(rows[0]?.['[d]']);
    return d ? `${d.y}-${pad2(d.m)}-${pad2(d.d)}` : null;
  } catch {
    return null;
  }
}
/**
 * Unshipped orders by SKU + attributes for the filter.
 * ⚠️ The fact is a daily snapshot and the measure is semi-additive (LASTNONBLANK PER ITEM).
 * Without pinning the date the SKU breakdown "sticks": an item that left the unshipped list
 * (order shipped) would keep showing its last non-zero value from an earlier date. So we pin
 * the LATEST snapshot date — each item's value is taken on that date and dropped items disappear.
 */
async function loadUnshipped(code, name) {
  const asOf = await loadUnshippedDate();
  const dateFilter = asOf
    ? (() => {
        const [y, m, d] = asOf.split('-').map(Number);
        return `, FILTER(ALL('Спр - Календарь'[Дата]),'Спр - Календарь'[Дата]=DATE(${y},${m},${d}))`;
      })()
    : '';
  const rows = await dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Номенклатура'[Код], 'Спр - Номенклатура'[Номенклатура], 'Спр - Номенклатура'[Бренд],
  'Спр - Номенклатура'[Товарная группа], 'Спр - Виды номенклатуры'[Вид номенклатуры],
  ${partnerFilter(code, name)}${dateFilter},
  "sum", [# Сумма (Неотгруженные заказы клиентам)],
  "qty", [# Количество (в единицах хранения) (Неотгруженные заказы клиентам)]
)`);
  const items = rows
    .map(r => ({
      code: s(r['Спр - Номенклатура[Код]']),
      name: s(r['Спр - Номенклатура[Номенклатура]']) || '— не указано —',
      brand: clean(r['Спр - Номенклатура[Бренд]']) || '— без марки —',
      group: clean(r['Спр - Номенклатура[Товарная группа]']) || '— без группы —',
      kind: clean(r['Спр - Виды номенклатуры[Вид номенклатуры]']) || '— не указан —',
      sum: num(r['[sum]']),
      qty: num(r['[qty]']),
    }))
    .filter(r => r.sum !== 0 || r.qty !== 0)
    .sort((a, b) => b.sum - a.sum);
  return {
    items,
    totalSum: items.reduce((t, r) => t + r.sum, 0),
    totalQty: items.reduce((t, r) => t + r.qty, 0),
    asOf,
  };
}
/** Latest receivables report date (semi-additive fact — snapshot as of a date). */
async function loadDebtDate() {
  try {
    const rows = await dax(
      `EVALUATE ROW("d", CALCULATE(MAX('Факт - Задолженность клиентов по срокам долга'[Дата отчета])))`,
    );
    const d = parseCubeDate(rows[0]?.['[d]']);
    return d ? `${d.y}-${pad2(d.m)}-${pad2(d.d)}` : null;
  } catch {
    return null;
  }
}
async function loadDebt(code, name) {
  const asOf = await loadDebtDate();
  if (!asOf)
    return { asOf: null, total: 0, overdue: 0, ourDebt: 0, toShip: 0, plannedShip: 0, intervals: [] };
  const [y, m, d] = asOf.split('-').map(Number);
  const dateFilter = `FILTER(ALL('Спр - Календарь'[Дата]),'Спр - Календарь'[Дата]=DATE(${y},${m},${d}))`;
  const [totRows, intRows] = await Promise.all([
    dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Партнеры'[Код],
  ${partnerFilter(code, name)}, ${dateFilter},
  "debt", [# Долг клиента], "overdue", [# Долг клиента (просрочено)],
  "our", [# Наш долг], "toship", [# К отгрузке в валюте отчета],
  "planship", [# Планируемая отгрузка клиенту]
)`),
    dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Факт - Задолженность клиентов по срокам долга'[Интервал просроченной задолженности],
  'Факт - Задолженность клиентов по срокам долга'[Номер интервала],
  ${partnerFilter(code, name)}, ${dateFilter},
  "debt", [# Долг клиента], "overdue", [# Долг клиента (просрочено)]
)`),
  ]);
  const t = totRows[0] ?? {};
  const intervals = intRows
    .map(r => ({
      interval:
        s(r['Факт - Задолженность клиентов по срокам долга[Интервал просроченной задолженности]']) || '—',
      num: num(r['Факт - Задолженность клиентов по срокам долга[Номер интервала]']),
      debt: num(r['[debt]']),
      overdue: num(r['[overdue]']),
    }))
    .filter(r => r.debt !== 0 || r.overdue !== 0)
    .sort((a, b) => a.num - b.num);
  return {
    asOf,
    total: num(t['[debt]']),
    overdue: num(t['[overdue]']),
    ourDebt: num(t['[our]']),
    toShip: num(t['[toship]']),
    plannedShip: num(t['[planship]']),
    intervals,
  };
}
/** Client bindings FROM THE PLAN: RM (Аналитика 1), TM (Аналитика 2), regions (Аналитика 3), segments (Аналитика 6). */
async function loadPlanDims(name) {
  const empty = { rm: [], tm: [], regions: [], segments: [] };
  if (!name) return empty;
  const rows = await dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Факт - План Факт'[Аналитика 1], 'Факт - План Факт'[Аналитика 2],
  'Факт - План Факт'[Аналитика 3], 'Факт - План Факт'[Аналитика 6],
  ${planArticleFilter()},
  FILTER(ALL('Факт - План Факт'[Аналитика 4]),'Факт - План Факт'[Аналитика 4]=${daxStr(name)}),
  "plan", [# Сумма сценария]
)`);
  const rm = new Set(),
    tm = new Set(),
    regions = new Set(),
    segments = new Set();
  for (const r of rows) {
    const a = clean(r['Факт - План Факт[Аналитика 1]']);
    if (a) rm.add(a);
    const b = clean(r['Факт - План Факт[Аналитика 2]']);
    if (b) tm.add(b);
    const c = clean(r['Факт - План Факт[Аналитика 3]']);
    if (c) regions.add(c);
    const d = clean(r['Факт - План Факт[Аналитика 6]']);
    if (d) segments.add(d);
  }
  const sortRu = set => Array.from(set).sort((x, y) => x.localeCompare(y, 'ru'));
  return { rm: sortRu(rm), tm: sortRu(tm), regions: sortRu(regions), segments: sortRu(segments) };
}
async function loadBreakdown(code, name, p, table, column) {
  const rows = await dax(`
EVALUATE
SUMMARIZECOLUMNS(
  '${table}'[${column}],
  ${partnerFilter(code, name)}, ${periodFilter(p)},
  "rev", [# Выручка], "qty", [# Количество]
)`);
  return rows
    .map(r => ({
      name: clean(r[`${table}[${column}]`]) || '— не указан —',
      revenue: num(r['[rev]']),
      qty: num(r['[qty]']),
    }))
    .filter(r => r.revenue !== 0 || r.qty !== 0)
    .sort((a, b) => b.revenue - a.revenue);
}
/** Monthly order frequency — orders are counted THROUGH the fact table (otherwise the partner filter does not apply). */
async function loadFreq(code, name, p) {
  const rows = await dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Календарь'[Год], 'Спр - Календарь'[Порядковый номер Месяца],
  ${partnerFilter(code, name)}, ${periodFilter(p)},
  "orders", COUNTROWS(SUMMARIZE('Факт - Валовая прибыль', 'Спр - Заказы клиента'[PK | Суррогатный ключ])),
  "rev", [# Выручка]
)`);
  return rows
    .map(r => ({
      month: monthKey(r['Спр - Календарь[Год]'], r['Спр - Календарь[Порядковый номер Месяца]']),
      orders: num(r['[orders]']),
      revenue: num(r['[rev]']),
    }))
    .filter(r => r.orders !== 0 || r.revenue !== 0)
    .sort((a, b) => a.month.localeCompare(b.month));
}
/** Client's contract territory (dominant by sales): region (Группа-4) + territory (leaf). */
async function loadClientTerritory(code, name, p) {
  const rows = await dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Регионы и Территории'[Группа-4], 'Спр - Регионы и Территории'[Регион/территория],
  ${partnerFilter(code, name)}, ${periodFilter(p)},
  "rev", [# Выручка]
)`);
  let best = { region: '', territory: '', rev: -1 };
  for (const r of rows) {
    const rev = num(r['[rev]']);
    if (rev <= best.rev) continue;
    best = {
      region: clean(r['Спр - Регионы и Территории[Группа-4]']),
      territory: clean(r['Спр - Регионы и Территории[Регион/территория]']),
      rev,
    };
  }
  return { region: best.region, territory: best.territory };
}
export async function getCustomerProfile(id, from, to) {
  const cacheKey = `${id}|${from}|${to}`;
  const hit = profileCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PROFILE_TTL) return hit.data;
  const { code } = parseId(id);
  const period = makePeriod(from, to);
  // Passport first, sequentially: it provides the canonical name for the plan filter.
  const passport = await loadPassport(code, parseId(id).name).catch(e => {
    console.error('[profiles/customer] passport:', e);
    return null;
  });
  if (!passport) return null;
  const name = passport.name;
  let olapError = null;
  const safe = async (fn, fallback, tag) => {
    try {
      return await fn();
    } catch (e) {
      olapError ??= String(e?.message ?? e).slice(0, 300);
      console.error(`[profiles/customer] ${tag}:`, e);
      return fallback;
    }
  };
  // No new-product dictionary here — empty set: novelty.available = false and isNew = false
  // on items. The "Client agent" tab does not use these fields.
  const noveltyIds = new Set();
  const [sales, planM, defectItems, unshipped, debt, rm, tm, op, depts, freq, planDims, standing, terr] =
    await Promise.all([
      safe(() => loadSalesItems(code, name, period, noveltyIds), { items: [], churn: [] }, 'sales'),
      safe(() => loadPlanMonths(name), { byMonth: {}, total: 0 }, 'plan'),
      safe(() => loadDefectItems(code, name, period), [], 'defect'),
      safe(
        () => loadUnshipped(code, name),
        { items: [], totalSum: 0, totalQty: 0, asOf: null },
        'unshipped',
      ),
      safe(
        () => loadDebt(code, name),
        { asOf: null, total: 0, overdue: 0, ourDebt: 0, toShip: 0, plannedShip: 0, intervals: [] },
        'receivables',
      ),
      safe(
        () =>
          loadBreakdown(
            code,
            name,
            period,
            'Спр - Региональные менеджеры из заказов',
            'Региональный менеджер',
          ),
        [],
        'rm',
      ),
      safe(
        () =>
          loadBreakdown(
            code,
            name,
            period,
            'Спр - Территориальные менеджеры из заказов',
            'Территориальный менеджер',
          ),
        [],
        'tm',
      ),
      safe(
        () =>
          loadBreakdown(
            code,
            name,
            period,
            'Спр - Менеджеры-операторы отдела продаж из заказов',
            'Менеджер-оператор отдела продаж',
          ),
        [],
        'operator',
      ),
      safe(
        () => loadBreakdown(code, name, period, 'Спр - Структура предприятия', 'Подразделение'),
        [],
        'departments',
      ),
      safe(() => loadFreq(code, name, period), [], 'frequency'),
      safe(() => loadPlanDims(name), { rm: [], tm: [], regions: [], segments: [] }, 'plan-bindings'),
      safe(
        () => loadStanding(code, name, period),
        { companySales: 0, rank: 0, partners: 0, share: 0, abc: null },
        'standing',
      ),
      safe(() => loadClientTerritory(code, name, period), { region: '', territory: '' }, 'territory'),
    ]);
  // New-product summary in the client's purchases (items flagged isNew).
  const totalRev = sales.items.reduce((t, it) => t + it.months.reduce((s2, m) => s2 + m.rev, 0), 0);
  const novItems = sales.items.filter(it => it.isNew);
  const novRev = novItems.reduce((t, it) => t + it.months.reduce((s2, m) => s2 + m.rev, 0), 0);
  const novelty = {
    available: noveltyIds.size > 0,
    count: novItems.length,
    revenue: novRev,
    share: totalRev > 0 ? novRev / totalRev : 0,
  };
  const data = {
    passport,
    period: {
      from: `${period.fromY}-${String(period.fromM).padStart(2, '0')}`,
      to: `${period.toY}-${String(period.toM).padStart(2, '0')}`,
    },
    planYear: PLAN_YEAR,
    standing,
    novelty,
    salesItems: sales.items,
    churn: sales.churn,
    planByMonth: planM.byMonth,
    planTotal: planM.total,
    defect: { items: defectItems },
    unshipped,
    debt,
    bindings: {
      rm,
      tm,
      op,
      depts,
      planRm: planDims.rm,
      planTm: planDims.tm,
      regionsPlan: planDims.regions,
      segments: planDims.segments,
      terrRegion: terr.region,
      terrTerritory: terr.territory,
      freq,
      priceTypesAvailable: false,
    },
    olapError,
  };
  profileCache.set(cacheKey, { at: Date.now(), data });
  return data;
}
// ══════════════════════════════════════════════════════════════════════════════
// PRICES — client selling price over time vs the base price effective at the sale date
// ══════════════════════════════════════════════════════════════════════════════
//
// Selling price = [# Выручка] / [# Количество] per SKU × month (from the cube, EXCLUDING VAT).
// Base price = the ERP base price list (product price register, via the DWH) effective in the
// month of sale (latest record starting ≤ that month). SKU ↔ price list are matched by the
// product business key (GUID).
export const BASE_PRICE_LABEL = 'Базовая 2026';
const PRICES_TTL = 5 * 60 * 1000;
const pricesCache = new Map();
/** Base price effective in the month of sale: the latest price record starting ≤ ym. */
function priceAt(timeline, ym) {
  if (!timeline || !timeline.length) return null;
  let val = null;
  for (const p of timeline) {
    if (p.ym <= ym) val = p.price;
    else break;
  }
  return val;
}
// VAT: the base price list is stored INCLUDING VAT, while the selling price (revenue/units) EXCLUDES it.
// The base price is converted to ex-VAT by dividing by (1 + rate). The rate depends on the YEAR of
// the sale month: 22% from 2026, 20% before (overridable via env).
const VAT_FROM_2026 = Number(process.env.CUSTOMER_VAT_2026) || 0.22;
const VAT_BEFORE = Number(process.env.CUSTOMER_VAT_BEFORE) || 0.2;
const vatRate = year => (year >= 2026 ? VAT_FROM_2026 : VAT_BEFORE);
const baseNet = (gross, year) => (gross == null ? null : gross / (1 + vatRate(year)));
export async function getCustomerPrices(id, from, to) {
  const cacheKey = `${id}|${from}|${to}`;
  const hit = pricesCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PRICES_TTL) return hit.data;
  const { code, name: rawName } = parseId(id);
  const period = makePeriod(from, to);
  let olapError = null;
  let name = rawName;
  if (code) {
    const passport = await loadPassport(code, rawName).catch(() => null);
    if (!passport) return null;
    name = passport.name;
  }
  // Sales by SKU × month + dimensions (brand = trademark, product group via FK, product kind, GUID).
  let saleRows = [];
  try {
    [saleRows] = await Promise.all([
      dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Номенклатура'[Код], 'Спр - Номенклатура'[Номенклатура],
  'Спр - Номенклатура'[Бизнес-ключ (GUID/Ref из 1С)], 'Спр - Номенклатура'[Бренд],
  'Спр - Номенклатура'[Товарная группа], 'Спр - Виды номенклатуры'[Вид номенклатуры],
  'Спр - Календарь'[Год], 'Спр - Календарь'[Порядковый номер Месяца],
  ${partnerFilter(code, name)}, ${periodFilter(period)},
  "rev", [# Выручка], "qty", [# Количество]
)`),
    ]);
  } catch (e) {
    olapError = String(e?.message ?? e).slice(0, 300);
    console.error('[profiles/customer] prices (cube):', olapError);
  }
  // Base prices from the DWH (24h cache). If the DWH is not configured or fails, the section works without them.
  let basePrices = new Map();
  let basePricesAvailable = false;
  if (dwhConfigured()) {
    try {
      basePrices = await fetchBasePrices();
      basePricesAvailable = true;
    } catch (e) {
      console.error('[profiles/customer] base prices (DWH):', e);
    }
  }
  const bySku = new Map();
  const monthSet = new Set();
  for (const r of saleRows) {
    const skuCode = s(r['Спр - Номенклатура[Код]']);
    if (!skuCode) continue;
    const month = monthKey(r['Спр - Календарь[Год]'], r['Спр - Календарь[Порядковый номер Месяца]']);
    monthSet.add(month);
    if (!bySku.has(skuCode))
      bySku.set(skuCode, {
        code: skuCode,
        name: s(r['Спр - Номенклатура[Номенклатура]']) || skuCode,
        brand: clean(r['Спр - Номенклатура[Бренд]']) || '— без марки —',
        group: clean(r['Спр - Номенклатура[Товарная группа]']) || '— без группы —',
        kind: clean(r['Спр - Виды номенклатуры[Вид номенклатуры]']) || '— не указан —',
        guid: s(r['Спр - Номенклатура[Бизнес-ключ (GUID/Ref из 1С)]']).toLowerCase(),
        byMonth: new Map(),
      });
    const a = bySku.get(skuCode);
    const cur = a.byMonth.get(month) ?? { qty: 0, rev: 0 };
    cur.qty += num(r['[qty]']);
    cur.rev += num(r['[rev]']);
    a.byMonth.set(month, cur);
  }
  // Benchmark: average selling price across ALL clients (no partner filter) for the same items and
  // months — shows whether the client buys above or below the market. avg = Σrevenue ÷ Σunits.
  const marketByKey = new Map(); // "code|month"
  const codes = Array.from(bySku.keys());
  if (codes.length) {
    try {
      const mkt = await dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Номенклатура'[Код], 'Спр - Календарь'[Год], 'Спр - Календарь'[Порядковый номер Месяца],
  FILTER(ALL('Спр - Номенклатура'[Код]), 'Спр - Номенклатура'[Код] IN {${codes.map(daxStr).join(',')}}),
  ${periodFilter(period)},
  "rev", [# Выручка], "qty", [# Количество]
)`);
      for (const r of mkt) {
        const c = s(r['Спр - Номенклатура[Код]']);
        if (!c) continue;
        const m = monthKey(r['Спр - Календарь[Год]'], r['Спр - Календарь[Порядковый номер Месяца]']);
        marketByKey.set(`${c}|${m}`, { rev: num(r['[rev]']), qty: num(r['[qty]']) });
      }
    } catch (e) {
      console.error('[profiles/customer] price benchmark (cube):', e);
    }
  }
  const skus = Array.from(bySku.values())
    .map(a => {
      const timeline = basePrices.get(a.guid);
      const months = Array.from(a.byMonth.entries())
        .sort((x, y) => x[0].localeCompare(y[0]))
        .map(([month, v]) => {
          const [yy, mm] = month.split('-').map(Number);
          const mk = marketByKey.get(`${a.code}|${month}`);
          return {
            month,
            qty: v.qty,
            ship: v.qty > 0 ? v.rev / v.qty : 0,
            base: baseNet(priceAt(timeline, yy * 100 + mm), yy), // list price incl. VAT → ex-VAT
            avg: mk && mk.qty > 0 ? mk.rev / mk.qty : null, // average across all clients (ex-VAT)
          };
        });
      return { code: a.code, name: a.name, brand: a.brand, group: a.group, kind: a.kind, months };
    })
    .filter(s => s.months.some(m => m.qty !== 0));
  const uniqSort = vals => Array.from(new Set(vals)).sort((x, y) => x.localeCompare(y, 'ru'));
  const data = {
    months: Array.from(monthSet).sort(),
    skus: skus.sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    brands: uniqSort(skus.map(s => s.brand)),
    groups: uniqSort(skus.map(s => s.group)),
    kinds: uniqSort(skus.map(s => s.kind)),
    baseLabel: BASE_PRICE_LABEL,
    basePricesAvailable,
    olapError,
  };
  pricesCache.set(cacheKey, { at: Date.now(), data });
  return data;
}
const FREQ_TTL = 5 * 60 * 1000;
const freqCache = new Map();
export async function getCustomerFreq(id, from, to) {
  const cacheKey = `${id}|${from}|${to}`;
  const hit = freqCache.get(cacheKey);
  if (hit && Date.now() - hit.at < FREQ_TTL) return hit.data;
  const { code, name: rawName } = parseId(id);
  const period = makePeriod(from, to);
  let name = rawName;
  if (code) {
    const passport = await loadPassport(code, rawName).catch(() => null);
    if (!passport) return null;
    name = passport.name;
  }
  let olapError = null;
  let itemRows = [];
  let total = [];
  try {
    [itemRows, total] = await Promise.all([
      dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Номенклатура'[Код], 'Спр - Номенклатура'[Номенклатура], 'Спр - Номенклатура'[Бренд],
  'Спр - Номенклатура'[Товарная группа], 'Спр - Виды номенклатуры'[Вид номенклатуры],
  'Спр - Календарь'[Год], 'Спр - Календарь'[Порядковый номер Месяца],
  ${partnerFilter(code, name)}, ${periodFilter(period)},
  "orders", COUNTROWS(SUMMARIZE('Факт - Валовая прибыль', 'Спр - Заказы клиента'[PK | Суррогатный ключ]))
)`),
      loadFreq(code, name, period),
    ]);
  } catch (e) {
    olapError = String(e?.message ?? e).slice(0, 300);
    console.error('[profiles/customer] frequency (cube):', olapError);
  }
  const bySku = new Map();
  const monthSet = new Set();
  for (const r of itemRows) {
    const sku = s(r['Спр - Номенклатура[Код]']);
    if (!sku) continue;
    const orders = num(r['[orders]']);
    if (orders === 0) continue;
    const month = monthKey(r['Спр - Календарь[Год]'], r['Спр - Календарь[Порядковый номер Месяца]']);
    monthSet.add(month);
    if (!bySku.has(sku))
      bySku.set(sku, {
        code: sku,
        name: s(r['Спр - Номенклатура[Номенклатура]']) || sku,
        brand: clean(r['Спр - Номенклатура[Бренд]']) || '— без марки —',
        group: clean(r['Спр - Номенклатура[Товарная группа]']) || '— без группы —',
        kind: clean(r['Спр - Виды номенклатуры[Вид номенклатуры]']) || '— не указан —',
        months: [],
      });
    bySku.get(sku).months.push({ month, orders });
  }
  for (const r of total) monthSet.add(r.month);
  const items = Array.from(bySku.values())
    .map(it => ({ ...it, months: it.months.sort((a, b) => a.month.localeCompare(b.month)) }))
    .sort((a, b) => b.months.reduce((t, m) => t + m.orders, 0) - a.months.reduce((t, m) => t + m.orders, 0));
  const data = {
    months: Array.from(monthSet).sort(),
    items,
    totalByMonth: total.map(r => ({ month: r.month, orders: r.orders })),
    olapError,
  };
  freqCache.set(cacheKey, { at: Date.now(), data });
  return data;
}
// ══════════════════════════════════════════════════════════════════════════════
// BRAND MIX AT A LARGER SCOPE (for comparison with the client)
// ══════════════════════════════════════════════════════════════════════════════
//
// Returns the brand purchase mix of the whole scope the client belongs to: its department, or its
// territory (2 levels: RM = level 1, TM = level 2). On the overview the client's brand mix is
// compared with the selected scope. Sales facts are sliced by the same dimensions as the bindings.
// Comparison scopes. Territory comes from the CONTRACT ('Спр - Регионы и Территории'), two levels:
// L1 region = Группа-4 (the hierarchy is right-aligned, so the region lands in Группа-4),
// L2 = leaf [Регион/территория].
const STRUCT_DIM = {
  dept: ['Спр - Структура предприятия', 'Подразделение'],
  terr1: ['Спр - Регионы и Территории', 'Группа-4'],
  terr2: ['Спр - Регионы и Территории', 'Регион/территория'],
};
const STRUCT_TTL = 10 * 60 * 1000;
const structCache = new Map();
export async function getCustomerStructure(scope, unit, from, to) {
  const dim = STRUCT_DIM[scope];
  if (!dim || !unit) return null;
  const p = makePeriod(from, to);
  const cacheKey = `${scope}|${unit}|${p.fromY}-${p.fromM}|${p.toY}-${p.toM}`;
  const hit = structCache.get(cacheKey);
  if (hit && Date.now() - hit.at < STRUCT_TTL) return hit.data;
  const rows = await dax(`
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Номенклатура'[Бренд],
  FILTER(ALL('${dim[0]}'[${dim[1]}]),'${dim[0]}'[${dim[1]}]=${daxStr(unit)}),
  ${periodFilter(p)},
  "rev", [# Выручка]
)`);
  const list = rows
    .map(r => ({ brand: clean(r['Спр - Номенклатура[Бренд]']) || '— без марки —', rev: num(r['[rev]']) }))
    .filter(b => b.rev > 0)
    .sort((a, b) => b.rev - a.rev);
  const total = list.reduce((t, b) => t + b.rev, 0);
  const data = {
    scope,
    unit,
    total,
    brands: list.map(b => ({ ...b, share: total > 0 ? b.rev / total : 0 })),
  };
  structCache.set(cacheKey, { at: Date.now(), data });
  return data;
}
