// DATA_SOURCE=olap: snapshot from the OLAP cube (SSAS Tabular, DAX via XMLA) and the DWH (MS SQL).
//
// The snapshot is assembled IN MEMORY from the cube and the DWH — no temp files — and injected into
// the report's HTML template as JSON. The snapshot shape is defined by the shared core
// (snapshotCore.js): this module only fetches facts and dictionaries and maps them into registries.
//
// WHY A SNAPSHOT, NOT A QUERY PER FILTER. The dashboard cross-filters all sales rows and computes
// ABC / new products / plan allocation in the browser. Live DAX per click would mean seconds per
// click and rewriting all the logic. An in-RAM snapshot keeps both interactivity and proven logic.
//
// HEAVY SALES FACT. XMLA responses are verbose (long escaped tag names), so sales are fetched
// COMPACTLY by surrogate keys with one-letter aliases (SELECTCOLUMNS) and MONTH BY MONTH, while
// names come from separate small dictionaries.
//
// Connection settings come only from environment variables (see .env.example, olapClient.js, dwhClient.js).
import { dax, shortName } from '../olapClient.js';
import {
  fetchStrategicPlan,
  fetchForecast,
  fetchTrademarks,
  fetchBasePrices,
  forecastSource,
  strategicSource,
  dwhConfigured,
} from '../dwhClient.js';
import {
  NA,
  cleanGroup,
  planGroup,
  newRegistries,
  itemOut,
  partnerDims,
  dedupDefect,
  defectWithoutDedup,
  packSnapshot,
} from './snapshotCore.js';
import { DEPTS_WL, FIRST_YEAR, FC_YEAR, PLAN_ARTICLE } from './reportConfig.js';
const daxStrLit = s => `"${s.replace(/"/g, '""')}"`;
const deptFilter = table =>
  `FILTER(ALL('${table}'[Подразделение]),'${table}'[Подразделение] IN {${DEPTS_WL.map(daxStrLit).join(',')}})`;
// The report's product universe is defined by the product's financial accounting settings group:
// only saleable goods are kept (default 'Товар,Продукция' — goods and finished products).
// Override with REPORT_FIN_GROUPS.
const FIN_GROUPS = new Set(
  (process.env.REPORT_FIN_GROUPS || 'Товар,Продукция')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
);
const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const ri = v => Math.round(num(v));
const ymFromDate = s => {
  const m = String(s ?? '').match(/(\d{4})-(\d{2})/);
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
};
// normalise row keys to short names (SELECTCOLUMNS returns '[k]', SUMMARIZECOLUMNS returns 'Table[Col]')
const normRows = rows =>
  rows.map(r => {
    const o = {};
    for (const k in r) o[shortName(k)] = r[k];
    return o;
  });
// ——— DAX queries ———
const daxItemDim = () => `
EVALUATE
SELECTCOLUMNS(
  SUMMARIZECOLUMNS(
    'Спр - Номенклатура объединенная'[PK | Суррогатный ключ],
    'Спр - Номенклатура объединенная'[Номенклатура],
    'Спр - Номенклатура объединенная'[Бренд],
    'Спр - Номенклатура объединенная'[Суббренд],
    'Спр - Номенклатура объединенная'[Код],
    'Спр - Номенклатура объединенная'[FK | (рит) Аналитика для мотивации (Общая)],
    'Спр - Номенклатура объединенная'[Товарная группа],
    'Спр - Номенклатура объединенная'[Группа-1],
    'Спр - Номенклатура объединенная'[Группа-2],
    'Спр - Номенклатура объединенная'[Группа-3],
    'Спр - Номенклатура объединенная'[Группа-4],
    'Спр - Номенклатура объединенная'[Этап развития],
    'Спр - Номенклатура объединенная'[Бизнес-ключ (GUID/Ref из 1С)],
    'Спр - Номенклатура объединенная'[FK | Вид номенклатуры],
    'Спр - Номенклатура объединенная'[Группа настроек фин. учета],
    ${deptFilter('Спр - Структура предприятия')},
    FILTER(ALL('Спр - Календарь'[Год]),'Спр - Календарь'[Год]>=${FIRST_YEAR}),
    "qq",[# Количество]
  ),
  "k",'Спр - Номенклатура объединенная'[PK | Суррогатный ключ],
  "n",'Спр - Номенклатура объединенная'[Номенклатура],
  "b",'Спр - Номенклатура объединенная'[Бренд],
  "sb",'Спр - Номенклатура объединенная'[Суббренд],
  "c",'Спр - Номенклатура объединенная'[Код],
  "mc",'Спр - Номенклатура объединенная'[FK | (рит) Аналитика для мотивации (Общая)],
  "tg",'Спр - Номенклатура объединенная'[Товарная группа],
  "g1",'Спр - Номенклатура объединенная'[Группа-1],
  "g2",'Спр - Номенклатура объединенная'[Группа-2],
  "g3",'Спр - Номенклатура объединенная'[Группа-3],
  "g4",'Спр - Номенклатура объединенная'[Группа-4],
  "st",'Спр - Номенклатура объединенная'[Этап развития],
  "bk",LOWER('Спр - Номенклатура объединенная'[Бизнес-ключ (GUID/Ref из 1С)]),
  "vk",'Спр - Номенклатура объединенная'[FK | Вид номенклатуры],
  "fg",'Спр - Номенклатура объединенная'[Группа настроек фин. учета]
)`;
const daxDeptDim = () =>
  `EVALUATE SELECTCOLUMNS('Спр - Структура предприятия',"k",'Спр - Структура предприятия'[PK | Суррогатный ключ],"n",'Спр - Структура предприятия'[Подразделение],"p",'Спр - Структура предприятия'[Вышестоящее подразделение])`;
const daxPartnerDim = () =>
  `EVALUATE SELECTCOLUMNS('Спр - Партнеры',"k",'Спр - Партнеры'[PK | Суррогатный ключ],"n",'Спр - Партнеры'[Партнер])`;
// Product kinds (product FK → name)
const daxViewKinds = () =>
  `EVALUATE SELECTCOLUMNS('Спр - Виды номенклатуры',"sk",'Спр - Виды номенклатуры'[PK | Суррогатный ключ],"name",'Спр - Виды номенклатуры'[Вид номенклатуры])`;
const daxPartnerSeed = () => `
EVALUATE
SUMMARIZECOLUMNS('Спр - Партнеры'[Партнер],
  ${deptFilter('Спр - Структура предприятия')},
  FILTER(ALL('Спр - Календарь'[Год]),'Спр - Календарь'[Год]>=${FIRST_YEAR}),
  "q",[# Количество])`;
// Product group → "direction" (top level) dictionary. Group-4 holds the direction name or a
// technical category / 'Неизвестно'; if Group-4 is empty, the product group itself is the top
// level (its Group-4 = 'Неизвестно'). The browser receives this as the "direction".
const daxTovgrpDir = () =>
  `EVALUATE SELECTCOLUMNS('Спр - Товарные группы',"tg",'Спр - Товарные группы'[Товарная группа],"d",'Спр - Товарные группы'[Группа-4])`;
// Client territory (from contracts), two levels: Group-4 = parent (region), Region/territory =
// territory. Linked to the partner via the revenue fact; per partner the territory with the
// LARGEST revenue wins.
const daxPartnerTerr = () => `
EVALUATE
SELECTCOLUMNS(
  SUMMARIZECOLUMNS(
    'Спр - Партнеры'[Партнер],
    'Спр - Регионы и Территории'[Группа-4],
    'Спр - Регионы и Территории'[Регион/территория],
    FILTER(ALL('Спр - Календарь'[Год]),'Спр - Календарь'[Год]>=${FIRST_YEAR}),
    "vv",[# Выручка]
  ),
  "p",'Спр - Партнеры'[Партнер],
  "t1",'Спр - Регионы и Территории'[Группа-4],
  "t2",'Спр - Регионы и Территории'[Регион/территория],
  "v",[vv]
)`;
// Client's regional and territory managers (from contracts). Linked to the partner via the revenue
// fact; per partner the manager with the LARGEST revenue wins, separately for each manager kind.
const daxPartnerMgr = () => `
EVALUATE
SELECTCOLUMNS(
  SUMMARIZECOLUMNS(
    'Спр - Партнеры'[Партнер],
    'Спр - Региональные менеджеры из договоров'[Региональный менеджер],
    'Спр - Территориальные менеджеры из договоров'[Территориальный менеджер],
    FILTER(ALL('Спр - Календарь'[Год]),'Спр - Календарь'[Год]>=${FIRST_YEAR}),
    "vv",[# Выручка]
  ),
  "p",'Спр - Партнеры'[Партнер],
  "rm",'Спр - Региональные менеджеры из договоров'[Региональный менеджер],
  "tm",'Спр - Территориальные менеджеры из договоров'[Территориальный менеджер],
  "v",[vv]
)`;
// Sales — compact, by keys; one CHUNK = one (year, month). Monthly (not yearly) so that each
// response stays small and within the timeout even on a cold/slow cube.
const daxSalesMonth = (year, month) => `
EVALUATE
SELECTCOLUMNS(
  SUMMARIZECOLUMNS(
    'Спр - Номенклатура объединенная'[PK | Суррогатный ключ],
    'Спр - Структура предприятия'[PK | Суррогатный ключ],
    'Спр - Партнеры'[PK | Суррогатный ключ],
    ${deptFilter('Спр - Структура предприятия')},
    FILTER(ALL('Спр - Календарь'[Год]),'Спр - Календарь'[Год]=${year}),
    FILTER(ALL('Спр - Календарь'[Порядковый номер Месяца]),'Спр - Календарь'[Порядковый номер Месяца]=${month}),
    "rr",[# Выручка],"qq",[# Количество]
  ),
  "i",'Спр - Номенклатура объединенная'[PK | Суррогатный ключ],
  "d",'Спр - Структура предприятия'[PK | Суррогатный ключ],
  "p",'Спр - Партнеры'[PK | Суррогатный ключ],
  "r",[rr],"q",[qq]
)`;
// Unfulfilled demand — by year (also a large detailed fact; chunked to stay within the timeout on a slow cube).
const daxDefectYear = year => `
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Номенклатура объединенная'[Номенклатура],
  'Спр - Структура предприятия из договоров'[Подразделение],
  'Спр - Партнеры'[Партнер],
  'Спр - Календарь'[Порядковый номер Месяца],
  ${deptFilter('Спр - Структура предприятия из договоров')},
  FILTER(ALL('Спр - Календарь'[Год]),'Спр - Календарь'[Год]=${year}),
  "dq",[# Дефектура, шт.],"ds",[# Дефектура на сумму]
)`;
// Daily unfulfilled demand (product × partner × order date) — only for de-duplication of repeats:
// we need the client's largest single-day order in a month. No department — computed per client.
const daxDefectDayYear = year => `
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Номенклатура объединенная'[Номенклатура],
  'Спр - Партнеры'[Партнер],
  'Спр - Календарь'[Дата],
  ${deptFilter('Спр - Структура предприятия из договоров')},
  FILTER(ALL('Спр - Календарь'[Год]),'Спр - Календарь'[Год]=${year}),
  "dq",[# Дефектура, шт.]
)`;
const daxStock = () => `
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Номенклатура объединенная'[Номенклатура],
  'Спр - Календарь'[Год],
  'Спр - Календарь'[Порядковый номер Месяца],
  FILTER(ALL('Спр - Календарь'[Год]),'Спр - Календарь'[Год]>=${FIRST_YEAR}),
  "stock",[# В наличии],"otg",[# Отгружается],"rez",[# В резерве]
)`;
// Production. ⚠️ This fact is a PERIODIC SNAPSHOT (by report snapshot date, often daily); each
// snapshot holds plan/actual for several production months. Grouping by the calendar dimension
// sums snapshots (inflated totals), and the #-measures by production month are semi-additive and
// return only the globally latest snapshot (history before the current month is lost). Correct
// approach: for each production month M take the snapshot as of the end of THAT month — the last
// snapshot of M, rows with production month = M, BASE columns (SUM). This gives a stable,
// non-inflated series by production month.
const daxProd = () => `
EVALUATE
VAR srezMk =
  ADDCOLUMNS(
    SUMMARIZE('Факт - Исполнение плана производства','Факт - Исполнение плана производства'[Дата среза аналитики отчета]),
    "mk", YEAR('Факт - Исполнение плана производства'[Дата среза аналитики отчета])*100+MONTH('Факт - Исполнение плана производства'[Дата среза аналитики отчета]))
VAR maxByMonth = GROUPBY(srezMk,[mk],"d",MAXX(CURRENTGROUP(),[Дата среза аналитики отчета]))
VAR maxDates = SELECTCOLUMNS(maxByMonth,"d",[d])
RETURN
SUMMARIZECOLUMNS(
  'Спр - Номенклатура объединенная'[Номенклатура],
  'Факт - Исполнение плана производства'[Период месяц],
  FILTER('Факт - Исполнение плана производства',
    ('Факт - Исполнение плана производства'[Дата среза аналитики отчета] IN maxDates)
    && YEAR('Факт - Исполнение плана производства'[Дата среза аналитики отчета])=YEAR('Факт - Исполнение плана производства'[Период месяц])
    && MONTH('Факт - Исполнение плана производства'[Дата среза аналитики отчета])=MONTH('Факт - Исполнение плана производства'[Период месяц])),
  "appr",SUM('Факт - Исполнение плана производства'[Заявки утверждено]),
  "plan",SUM('Факт - Исполнение плана производства'[План производства утверждено]),
  "made",SUM('Факт - Исполнение плана производства'[Заказы произведено])
)`;
const daxPlan = () => `
EVALUATE
SUMMARIZECOLUMNS(
  'Спр - Структура предприятия'[Подразделение],
  'Факт - План Факт'[Аналитика 4],
  'Факт - План Факт'[Аналитика 6],
  'Факт - План Факт'[Месяц отчетного периода],
  ${deptFilter('Спр - Структура предприятия')},
  FILTER(ALL('Факт - План Факт'[Статья бюджетов]),'Факт - План Факт'[Статья бюджетов]=${daxStrLit(PLAN_ARTICLE)}),
  "scenSum",[# Сумма сценария],"scenQty",[# Количество сценария]
)`;
// Map "business key (ERP GUID, lower case) → merged product name" for the forecast GUIDs.
// Maps forecast products onto the dashboard's CURRENT merged product list.
const daxNomByGuids = guids => `
EVALUATE
FILTER(
  SELECTCOLUMNS('Спр - Номенклатура объединенная',
    "g", LOWER('Спр - Номенклатура объединенная'[Бизнес-ключ (GUID/Ref из 1С)]),
    "n", 'Спр - Номенклатура объединенная'[Номенклатура]),
  [g] IN {${guids.map(daxStrLit).join(',')}}
)`;
// ——— snapshot assembly ———
// prev — the last successful snapshot (forecast fallback if the DWH fails) or null.
export async function buildOlapSnapshot({ prev = null } = {}) {
  const t0 = Date.now();
  const thisYear = new Date().getFullYear();
  const years = [];
  for (let y = FIRST_YEAR; y <= thisYear; y++) years.push(y);
  // Dictionaries and small facts in parallel (the olapClient queue limits concurrency).
  const [
    itemDimR,
    deptDimR,
    partDimR,
    viewKindsR,
    partSeedR,
    stockR,
    prodR,
    planR,
    tovgrpDirR,
    partTerrR,
    partMgrR,
  ] = await Promise.all([
    dax(daxItemDim()),
    dax(daxDeptDim()),
    dax(daxPartnerDim()),
    dax(daxViewKinds()),
    dax(daxPartnerSeed()),
    dax(daxStock()),
    dax(daxProd()),
    dax(daxPlan()),
    dax(daxTovgrpDir()),
    dax(daxPartnerTerr()),
    dax(daxPartnerMgr()),
  ]);
  const deptByPk = new Map();
  const deptParentByName = new Map(); // department -> parent department
  for (const r of normRows(deptDimR)) {
    const n = String(r.n ?? '');
    deptByPk.set(num(r.k), n);
    if (n && !deptParentByName.has(n)) deptParentByName.set(n, String(r.p ?? '').trim());
  }
  const partByPk = new Map();
  for (const r of normRows(partDimR)) partByPk.set(num(r.k), String(r.n ?? ''));
  const cleanTxt = s => {
    const t = String(s ?? '').trim();
    return !t || t === 'Неизвестно' || t.startsWith('<') ? '' : t;
  };
  const viewKindByPk = new Map();
  for (const r of normRows(viewKindsR)) viewKindByPk.set(num(r.sk), String(r.name ?? ''));
  // "Direction" (top level of the product group): Group-4 holds the direction; when Group-4 is
  // empty / 'Неизвестно', the product group itself is the top level.
  const dirByTg = new Map();
  for (const r of normRows(tovgrpDirR)) {
    const tg = String(r.tg ?? '').trim();
    if (!tg) continue;
    dirByTg.set(tg, cleanTxt(r.d) || tg);
  }
  const tgDirection = tg => (tg ? dirByTg.get(tg) || tg : '');
  const itemByPk = new Map();
  for (const r of normRows(itemDimR)) {
    const tg = cleanTxt(r.tg);
    itemByPk.set(num(r.k), {
      name: String(r.n ?? ''),
      brand: String(r.b ?? ''),
      sub: cleanTxt(r.sb),
      code: r.c == null ? '' : String(r.c),
      mc: r.mc == null ? -1 : ri(r.mc),
      tg,
      tgTop: tgDirection(tg),
      stage: r.st ? String(r.st) : NA,
      guid: String(r.bk ?? '').toLowerCase(),
      vidfk: r.vk == null ? -1 : ri(r.vk),
      fin: String(r.fg ?? '').trim(),
    });
  }
  // Territory per partner (largest by revenue): partner name → { t1, t2 }.
  const terrBest = new Map();
  for (const r of normRows(partTerrR)) {
    const p = String(r.p ?? '');
    if (!p) continue;
    const t1 = cleanTxt(r.t1),
      t2 = cleanTxt(r.t2);
    if (!t1 && !t2) continue;
    const v = num(r.v);
    const cur = terrBest.get(p);
    if (!cur || v > cur.v) terrBest.set(p, { t1: t1 || NA, t2: t2 || NA, v });
  }
  // Managers per partner (largest by revenue): regional and territory managers separately.
  const rmRev = new Map();
  const tmRev = new Map();
  const bump = (m, p, name, v) => {
    let inner = m.get(p);
    if (!inner) {
      inner = new Map();
      m.set(p, inner);
    }
    inner.set(name, (inner.get(name) || 0) + v);
  };
  for (const r of normRows(partMgrR)) {
    const p = String(r.p ?? '');
    if (!p) continue;
    const v = num(r.v);
    const rm = cleanTxt(r.rm),
      tm = cleanTxt(r.tm);
    if (rm) bump(rmRev, p, rm, v);
    if (tm) bump(tmRev, p, tm, v);
  }
  const domOf = inner => {
    if (!inner) return NA;
    let best = NA,
      bv = -1;
    inner.forEach((v, n) => {
      if (v > bv) {
        bv = v;
        best = n;
      }
    });
    return best;
  };
  // Trademark per product (DWH, cached 24h). Errors do not fail the snapshot.
  let tmByGuid = new Map();
  if (dwhConfigured()) {
    try {
      tmByGuid = await fetchTrademarks();
    } catch (e) {
      console.error('[report/sales] trademarks (DWH) error:', e?.message ?? e);
    }
  }
  const R = newRegistries();
  const { items, depts, partners, a6, motivLowers } = R;
  const attrByName = new Map();
  const finOk = fin => FIN_GROUPS.has(fin);
  // pre-seed partners (first those with actuals in the report's departments)
  for (const r of normRows(partSeedR)) {
    const n = String(r.Партнер ?? '');
    if (n) partners.id(n);
  }
  // SALES -> [itemId, deptId, partId, ym, rev, qty]; defines the product universe. Monthly.
  const sales = [];
  for (const year of years) {
    for (let mo = 1; mo <= 12; mo++) {
      const rows = normRows(await dax(daxSalesMonth(year, mo)));
      if (!rows.length) continue;
      const ym = year * 100 + mo;
      for (const r of rows) {
        const attr = itemByPk.get(num(r.i));
        if (!attr) continue;
        if (!finOk(attr.fin)) continue;
        const it = items.id(attr.name);
        if (!attrByName.has(attr.name)) attrByName.set(attr.name, attr);
        const dn = deptByPk.get(num(r.d)) ?? NA;
        const pn = partByPk.get(num(r.p)) ?? NA;
        sales.push([it, depts.id(dn), partners.id(pn), ym, ri(r.r), ri(r.q)]);
      }
    }
  }
  // UNFULFILLED DEMAND -> [it, deptId, partId, ym, dq, ds] (only products with sales); by year.
  const defect = [];
  for (const year of years) {
    for (const r of normRows(await dax(daxDefectYear(year)))) {
      const it = items.get(String(r.Номенклатура ?? ''));
      if (it === undefined) continue;
      const ym = year * 100 + ri(r['Порядковый номер Месяца']);
      defect.push([
        it,
        depts.id(String(r.Подразделение ?? '')),
        partners.id(String(r.Партнер ?? '')),
        ym,
        ri(r.dq),
        ri(r.ds),
      ]);
    }
  }
  // De-duplicate unfulfilled demand (algorithm in snapshotCore.dedupDefect); it needs the client's
  // largest single-day order per month, so we provide daily data.
  try {
    const dayMax = new Map();
    for (const year of years) {
      for (const r of normRows(await dax(daxDefectDayYear(year)))) {
        const it = items.get(String(r.Номенклатура ?? ''));
        if (it === undefined) continue;
        const m = /^(\d{4})-(\d{2})/.exec(String(r.Дата ?? '')); // XMLA returns dates as YYYY-MM-DDT00:00:00
        if (!m) continue;
        const k = `${it}|${partners.id(String(r.Партнер ?? ''))}|${Number(m[1]) * 100 + Number(m[2])}`;
        const q = ri(r.dq);
        if (q > (dayMax.get(k) || 0)) dayMax.set(k, q);
      }
    }
    dedupDefect(sales, defect, dayMax);
  } catch (e) {
    defectWithoutDedup(defect);
    console.error('[report/sales] defect dedup error:', e?.message ?? e);
  }
  // STOCK -> [it, ym, stock (on hand), free].
  // Free = on hand − being shipped − reserved (≤ on hand). The "available" measure is not used:
  // it includes expected receipts and can exceed stock on hand.
  const stock = [];
  for (const r of normRows(stockR)) {
    const it = items.get(String(r.Номенклатура ?? ''));
    if (it === undefined) continue;
    const ym = ri(r.Год) * 100 + ri(r['Порядковый номер Месяца']);
    const vn = ri(r.stock);
    const free = Math.max(0, vn - Math.max(0, ri(r.otg)) - Math.max(0, ri(r.rez)));
    stock.push([it, ym, vn, free]);
  }
  // PRODUCTION -> aggregated by (it, ym): [it, ym, appr, plan, made]
  const prodMap = new Map();
  for (const r of normRows(prodR)) {
    const it = items.get(String(r.Номенклатура ?? ''));
    if (it === undefined) continue;
    const ym = ymFromDate(r['Период месяц']);
    if (ym === null) continue;
    const key = it + '|' + ym;
    let v = prodMap.get(key);
    if (!v) {
      v = [it, ym, 0, 0, 0];
      prodMap.set(key, v);
    }
    v[2] += ri(r.appr);
    v[3] += ri(r.plan);
    v[4] += ri(r.made);
  }
  const prod = Array.from(prodMap.values()).filter(v => v[2] || v[3] || v[4]);
  // PLAN -> aggregated by (deptId, partId, a6Id, ym): [dept, part, a6, ym, scenSum, scenQty]
  const planMap = new Map();
  for (const r of normRows(planR)) {
    const ym = ymFromDate(r['Месяц отчетного периода']);
    if (ym === null) continue;
    const d = depts.id(String(r.Подразделение ?? ''));
    const p = partners.id(String(r['Аналитика 4'] ?? ''));
    const g = a6.id(planGroup(String(r['Аналитика 6'] ?? '')));
    const key = d + '|' + p + '|' + g + '|' + ym;
    let v = planMap.get(key);
    if (!v) {
      v = [d, p, g, ym, 0, 0];
      planMap.set(key, v);
    }
    v[4] += ri(r.scenSum);
    v[5] += ri(r.scenQty);
  }
  const plan = Array.from(planMap.values()).filter(v => v[4] || v[5]);
  // Products (in order of first appearance in sales) with attributes.
  const itemsOut = items.list.map(name => {
    const a = attrByName.get(name);
    return itemOut(
      name,
      {
        brand: a.brand,
        code: a.code,
        sub: a.sub,
        tg: a.tg,
        stage: a.stage,
        tgTop: a.tgTop,
        kind: a.vidfk > 0 ? viewKindByPk.get(a.vidfk) : null,
        mc: a.mc,
        trademark: tmByGuid.get(a.guid),
      },
      R,
    );
  });
  const dims = partnerDims(
    partners.list,
    name => terrBest.get(name),
    name => domOf(rmRev.get(name)),
    name => domOf(tmRev.get(name)),
  );
  // ── Analytical sales forecast (DWH, sales plan by product), in units ──
  // Forecast products are mapped to the current merged products (GUID → name from the cube). forecast: [itemId, ym, qty].
  let forecast = [];
  let forecastInfo = { ok: false, error: 'DWH не настроен' };
  if (dwhConfigured()) {
    try {
      const rows = await fetchForecast(FC_YEAR);
      const guids = Array.from(new Set(rows.map(r => r.guid)));
      const nameByGuid = new Map();
      for (let i = 0; i < guids.length; i += 4000) {
        for (const r of normRows(await dax(daxNomByGuids(guids.slice(i, i + 4000))))) {
          const g = String(r.g ?? '').toLowerCase();
          if (g) nameByGuid.set(g, String(r.n ?? ''));
        }
      }
      const fmap = new Map();
      let totalQty = 0,
        mappedQty = 0;
      const months = new Set();
      for (const r of rows) {
        totalQty += r.qty;
        months.add(r.ym);
        const name = nameByGuid.get(r.guid);
        const it = name != null ? items.get(name) : undefined;
        if (it === undefined) continue;
        mappedQty += r.qty;
        const key = it + '|' + r.ym;
        let v = fmap.get(key);
        if (!v) {
          v = [it, r.ym, 0];
          fmap.set(key, v);
        }
        v[2] += r.qty;
      }
      forecast = Array.from(fmap.values())
        .map(v => [v[0], v[1], Math.round(v[2])])
        .filter(v => v[2]);
      forecastInfo = {
        ok: true,
        ...forecastSource(),
        year: FC_YEAR,
        months: Array.from(months).sort((a, b) => a - b),
        positions: guids.length,
        totalQty: Math.round(totalQty),
        mappedQty: Math.round(mappedQty),
        unmappedQty: Math.round(totalQty - mappedQty),
      };
    } catch (e) {
      // DWH did not respond — keep the forecast from the last successful snapshot instead of clearing it.
      if (prev && Array.isArray(prev.forecast) && prev.forecast.length && prev.forecastInfo?.ok) {
        forecast = prev.forecast;
        forecastInfo = {
          ...prev.forecastInfo,
          stale: true,
          staleReason: String(e?.message ?? e).slice(0, 200),
          staleFrom: prev.at,
        };
        console.error('[report/sales] forecast (DWH) error — keeping the previous forecast:', e?.message ?? e);
      } else {
        forecastInfo = { ok: false, error: String(e?.message ?? e).slice(0, 300) };
        console.error('[report/sales] forecast (DWH) error:', e?.message ?? e);
      }
    }
  }
  // ── Strategic sales plan (DWH): department × incentive group (lower level) × month, ₽ ──
  // Departments map to existing ids; incentive groups go into the motivLowers registry (added if new).
  // stratPlan: [deptId, motivLowerId, ym, sum₽].
  let stratPlan = [];
  let stratInfo = { ok: false, error: 'DWH не настроен' };
  if (dwhConfigured()) {
    try {
      const rows = await fetchStrategicPlan();
      const spMap = new Map();
      let total = 0,
        mapped = 0;
      const unmatchedDepts = new Set();
      const months = new Set();
      for (const r of rows) {
        total += r.sum;
        months.add(r.ym);
        const d = depts.get(r.dept);
        if (d === undefined) {
          unmatchedDepts.add(r.dept);
          continue;
        }
        const ml = motivLowers.id(cleanGroup(r.motiv) || NA);
        mapped += r.sum;
        const key = d + '|' + ml + '|' + r.ym;
        let v = spMap.get(key);
        if (!v) {
          v = [d, ml, r.ym, 0];
          spMap.set(key, v);
        }
        v[3] += r.sum;
      }
      stratPlan = Array.from(spMap.values())
        .map(v => [v[0], v[1], v[2], Math.round(v[3])])
        .filter(v => v[3]);
      stratInfo = {
        ok: true,
        ...strategicSource(),
        months: Array.from(months).sort((a, b) => a - b),
        total: Math.round(total),
        mapped: Math.round(mapped),
        unmatched: Math.round(total - mapped),
        unmatchedDepts: Array.from(unmatchedDepts),
      };
    } catch (e) {
      stratInfo = { ok: false, error: String(e?.message ?? e).slice(0, 300) };
      console.error('[report/sales] strategic plan (DWH) error:', e?.message ?? e);
    }
  }
  // ── Base prices: basePrices[itemId] = latest effective base price (0 if none) ──
  let basePrices = new Array(itemsOut.length).fill(0);
  let basePriceInfo = { ok: false };
  if (dwhConfigured()) {
    try {
      const bp = await fetchBasePrices();
      let withPrice = 0;
      for (let id = 0; id < items.list.length; id++) {
        const a = attrByName.get(items.list[id]);
        const hist = a ? bp.get(a.guid) : undefined;
        if (hist && hist.length) {
          basePrices[id] = hist[hist.length - 1].price;
          withPrice++;
        }
      }
      basePriceInfo = { ok: true, withPrice, total: items.list.length };
    } catch (e) {
      basePriceInfo = { ok: false, error: String(e?.message ?? e).slice(0, 300) };
      console.error('[report/sales] base prices (DWH) error:', e?.message ?? e);
    }
  }
  return packSnapshot({
    source: 'olap',
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
