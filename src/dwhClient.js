// DWH (MS SQL Server) client for DATA_SOURCE=olap.
//
// What we read here:
//   - the strategic sales plan (it reaches the cube with a delay, the DWH has it fresh);
//   - the analytical sales forecast by product (sales-plan-by-product documents);
//   - product trademarks;
//   - base prices (product price register, primary and fallback price types).
//
// Configuration comes only from environment variables (see .env.example); there are no defaults
// pointing anywhere: DWH_HOST, DWH_PORT, DWH_DB, DWH_USER, DWH_PASS; base price types are
// BASE_PRICE_VID and BASE_PRICE_VID_FB (price-type GUIDs of the ERP system).
import sql from 'mssql';

const DWH_ARTICLE = process.env.DWH_STRAT_ARTICLE || 'План продаж по подразделениям 2025 по месяцам';
const DWH_SCENARIO = process.env.DWH_STRAT_SCENARIO || 'План по клиентам';

// Forecast: scenario and plan type by name (the DWH stores names, not GUIDs).
const FC_SCENARIO = process.env.REPORT_FORECAST_SCENARIO || 'Прогноз продаж';
const FC_VIDPLANA = process.env.REPORT_FORECAST_VIDPLANA || 'Прогноз продаж';

// Base prices: primary price type and fallback (used when a product has no primary price) — price-type GUIDs.
const BASE_PRICE_VID = (process.env.BASE_PRICE_VID || '').toLowerCase();
const BASE_PRICE_VID_FALLBACK = (process.env.BASE_PRICE_VID_FB || BASE_PRICE_VID).toLowerCase();

// Trademark and price dictionaries rarely change: cache them for a day instead of reloading on every build.
const DICT_TTL_MS = Number(process.env.DWH_DICT_TTL_MS) || 24 * 3600 * 1000;

export function dwhConfigured() {
  return !!(process.env.DWH_PASS && (process.env.DWH_HOST || process.env.DWH_SERVER) && process.env.DWH_DB);
}

function config() {
  return {
    server: process.env.DWH_HOST || process.env.DWH_SERVER,
    port: Number(process.env.DWH_PORT) || 1433,
    database: process.env.DWH_DB,
    user: process.env.DWH_USER || '',
    password: process.env.DWH_PASS || '',
    options: {
      // TLS off by default (DWH_ENCRYPT=true to enable)
      encrypt: process.env.DWH_ENCRYPT === 'true',
      trustServerCertificate: process.env.DWH_TRUST_CERT !== 'false',
      enableArithAbort: true,
    },
    connectionTimeout: Number(process.env.DWH_TIMEOUT_MS) || 30000,
    requestTimeout: Number(process.env.DWH_TIMEOUT_MS) || 120000,
    pool: { max: 2, min: 0, idleTimeoutMillis: 10000 },
  };
}

/** Opens a connection, runs fn(pool) and always closes the connection. */
async function withPool(fn) {
  const pool = new sql.ConnectionPool(config());
  try {
    await pool.connect();
    return await fn(pool);
  } finally {
    try {
      await pool.close();
    } catch {
      /* ignore */
    }
  }
}

// Strategic sales plan: [department (name), incentive group (name), ym, amount ₽].
// Only plan rows are taken (scenario amount IS NOT NULL); actuals rows are ignored.
// Data is split by department × "Analytics 1" (= incentive group, lower level) × month; the amount
// is monetary with no quantity — the report converts it to units using the average price.
export async function fetchStrategicPlan() {
  return withPool(async pool => {
    const res = await pool
      .request()
      .input('scen', sql.NVarChar, DWH_SCENARIO)
      .input('art', sql.NVarChar, DWH_ARTICLE).query(`
        SELECT s.[Подразделение] AS dept,
               f.[Аналитика 1] AS motiv,
               (YEAR(f.[Месяц отчетного периода]) * 100 + MONTH(f.[Месяц отчетного периода])) AS ym,
               SUM(f.[Сумма сценария]) AS s
        FROM dwh.c1erp_fact__plan_fact__vw f
        JOIN dwh.c1erp_dim__company_structure__vw s
          ON s.[PK | Суррогатный ключ] = f.[FK | Подразделение]
        WHERE f.[Сценарий] = @scen
          AND f.[Статья бюджетов] = @art
          AND f.[Сумма сценария] IS NOT NULL
        GROUP BY s.[Подразделение], f.[Аналитика 1],
                 YEAR(f.[Месяц отчетного периода]) * 100 + MONTH(f.[Месяц отчетного периода])`);
    return res.recordset
      .map(r => ({
        dept: String(r.dept ?? '').trim(),
        motiv: String(r.motiv ?? '').trim(),
        ym: Number(r.ym) || 0,
        sum: Number(r.s) || 0,
      }))
      .filter(r => r.ym > 0 && r.sum);
  });
}

/**
 * Analytical sales forecast by product for `year`: rows { guid, ym, qty }, where guid is the ERP
 * product GUID in lower case. Same data as the ERP sales-plan register: posted documents not marked
 * for deletion; the month is taken from the line's shipment date (or the period start if empty).
 */
export async function fetchForecast(year) {
  return withPool(async pool => {
    const res = await pool
      .request()
      .input('scen', sql.NVarChar, FC_SCENARIO)
      .input('vid', sql.NVarChar, FC_VIDPLANA)
      .input('from', sql.Date, `${year}-01-01`)
      .input('to', sql.Date, `${year + 1}-01-01`).query(`
        SELECT LOWER(i.[Бизнес-ключ (GUID/Ref из 1С)]) AS g,
               YEAR(x.d) * 100 + MONTH(x.d) AS ym,
               SUM(f.[Количество]) AS q
        FROM dwh.c1erp_fact__item_sale_plans__vw f
        JOIN dwh.c1erp_dim__items__vw i ON i.[PK | Суррогатный ключ] = f.[FK | Номенклатура]
        CROSS APPLY (SELECT COALESCE(f.[Дата отгрузки], f.[Начало периода]) AS d) x
        WHERE f.[Сценарий] = @scen AND f.[Вид плана] = @vid
          AND f.[Проведен] = N'Да' AND f.[Пометка удаления] = N'Нет'
          AND x.d >= @from AND x.d < @to
        GROUP BY LOWER(i.[Бизнес-ключ (GUID/Ref из 1С)]), YEAR(x.d) * 100 + MONTH(x.d)`);
    return res.recordset
      .map(r => ({ guid: String(r.g ?? ''), ym: Number(r.ym) || 0, qty: Number(r.q) || 0 }))
      .filter(r => r.guid && r.ym && r.qty);
  });
}

/** Forecast parameters — for the caption in the snapshot (forecastInfo). */
export const forecastSource = () => ({ scenario: FC_SCENARIO, vidPlana: FC_VIDPLANA });

/** Strategic plan parameters — for the caption in the snapshot (stratInfo). */
export const strategicSource = () => ({ scenario: DWH_SCENARIO, article: DWH_ARTICLE });

let tmCache = null;

/** Product GUID (lower case) → trademark name. Cached for a day. */
export async function fetchTrademarks() {
  if (tmCache && Date.now() - tmCache.at < DICT_TTL_MS) return tmCache.map;
  const map = await withPool(async pool => {
    const res = await pool.request().query(`
      SELECT LOWER(it.item_bk) AS g, b.name AS tm
      FROM dwh.c1erp_dim_items it
      JOIN dwh.c1erp_dim_rit_brands b ON b.brand_sk = it.trademark_sk AND b.is_current = 1
      WHERE it.trademark_sk > 0`);
    const m = new Map();
    for (const r of res.recordset) {
      const name = String(r.tm ?? '').trim();
      if (r.g && name) m.set(String(r.g), name);
    }
    return m;
  });
  tmCache = { map, at: Date.now() };
  return map;
}

let priceCache = null;

/**
 * Product GUID (lower case) → base price history [{ ym, price }] in ascending month order.
 * For each product the primary price type is used, or the fallback if there is none. Records from
 * the start of `fromYear`. Record order follows the register: by effective date, and for several
 * documents on the same date — by document and line. The report takes the last record, so the order
 * within a date matters. An empty price (NULL) is 0: such a record "resets" the product's base
 * price. Cached for a day.
 *
 * Known limitation: if the DWH does not track deleted or unposted documents, the history may keep
 * records of price-setting documents that were already cancelled.
 */
export async function fetchBasePrices(fromYear = 2024) {
  if (!BASE_PRICE_VID) throw new Error('BASE_PRICE_VID is not set — base price type GUID');
  if (priceCache && Date.now() - priceCache.at < DICT_TTL_MS) return priceCache.map;
  const map = await withPool(async pool => {
    const res = await pool
      .request()
      .input('prim', sql.UniqueIdentifier, BASE_PRICE_VID)
      .input('fb', sql.UniqueIdentifier, BASE_PRICE_VID_FALLBACK)
      .input('from', sql.Date, `${fromYear}-01-01`).query(`
        SELECT LOWER(it.item_bk) AS g, LOWER(CONVERT(varchar(36), p.price_kind_uuid)) AS k,
               p.begin_dt AS d, p.price
        FROM dwh.c1erp_scd_item_prices p
        JOIN dwh.c1erp_dim_items it ON it.item_sk = p.item_sk
        WHERE p.price_kind_uuid IN (@prim, @fb) AND p.begin_dt >= @from
        ORDER BY p.begin_dt, p.registrar, TRY_CAST(REPLACE(p.line_number, ' ', '') AS int)`);
    const prim = new Map();
    const fb = new Map();
    for (const r of res.recordset) {
      const price = Number(r.price);
      const d = r.d instanceof Date ? r.d : new Date(r.d);
      if (!r.g || !Number.isFinite(price) || isNaN(d.getTime())) continue;
      const ym = d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
      const target = r.k === BASE_PRICE_VID ? prim : fb;
      const arr = target.get(r.g) ?? [];
      arr.push({ ym, price });
      target.set(r.g, arr);
    }
    const acc = new Map(prim);
    for (const [g, arr] of fb) if (!acc.has(g)) acc.set(g, arr);
    acc.forEach(arr => arr.sort((a, b) => a.ym - b.ym));
    return acc;
  });
  priceCache = { map, at: Date.now() };
  return map;
}
