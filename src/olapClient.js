// OLAP cube client (SSAS Tabular): DAX queries via XMLA over HTTP (msmdpump).
//
// Used only by DATA_SOURCE=olap. Native ADOMD.NET is not needed (off Windows it cannot use the SSAS
// TCP transport): a POST with Basic auth plus rowset-XML parsing is enough — the parser is below,
// no extra dependencies.
//
// Configuration comes only from environment variables; there are no defaults pointing anywhere:
//   OLAP_URL      msmdpump.dll URL, e.g. https://olap.example.com/OLAP/msmdpump.dll
//   OLAP_USER     user
//   OLAP_PASS     password
//   OLAP_CATALOG  cube database (catalog)
//   OLAP_TIMEOUT_MS, OLAP_MAX_PARALLEL — request timeout and max in-flight requests
const URL_ = process.env.OLAP_URL || '';
const USER = process.env.OLAP_USER || '';
const PASS = process.env.OLAP_PASS || '';
const CATALOG = process.env.OLAP_CATALOG || '';
const TIMEOUT = Number(process.env.OLAP_TIMEOUT_MS) || 60_000;
const NOT_CONFIGURED = 'OLAP cube is not configured: set OLAP_URL, OLAP_USER, OLAP_PASS and OLAP_CATALOG';
const NS_ROWSET = 'urn:schemas-microsoft-com:xml-analysis:rowset';
function envelope(statement, catalog) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
      <Command><Statement><![CDATA[${statement}]]></Statement></Command>
      <Properties>
        <PropertyList>
          <Catalog>${catalog}</Catalog>
          <Format>Tabular</Format>
          <Content>SchemaData</Content>
        </PropertyList>
      </Properties>
    </Execute>
  </soap:Body>
</soap:Envelope>`;
}
const unescapeXml = s =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
/**
 * Parses an XMLA response. The format is flat, so a full XML parser would be overkill,
 * but there are two SSAS subtleties that are easy to get wrong:
 *
 *  1. A cell's TAG name is the column name with special characters XML-escaped:
 *     `Спр - Календарь[Год]` → `<Спр_x0020_-_x0020_Календарь_x005B_Год_x005D_>`.
 *     So tags may contain non-ASCII (Cyrillic) characters — a `\w` regex will not match them
 *     (in JS `\w` = [A-Za-z0-9_]). The human-readable name is in the schema, in sql:field.
 *  2. The value type comes either from the schema (`type="xsd:long"` for table columns)
 *     or from the cell itself (`xsi:type="xsd:double"` for measures) — both are handled.
 */
function parseRowset(xml) {
  const fault = xml.match(/<(?:\w+:)?Fault[\s\S]*?<\/(?:\w+:)?Fault>/);
  if (fault) {
    const desc =
      fault[0].match(/Description="([^"]*)"/)?.[1] ??
      fault[0]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    throw new Error(`OLAP XMLA Fault: ${unescapeXml(desc).slice(0, 500)}`);
  }
  // Schema: name="C0" … sql:field="Спр - Номенклатура[Код]" … type="xsd:double"
  const nameByTag = new Map();
  const typeByTag = new Map();
  const schemaRe = /<xsd:element[^>]*\sname="([^"]+)"[^>]*>/g;
  for (let m; (m = schemaRe.exec(xml)); ) {
    const tag = m[1];
    const field = m[0].match(/sql:field="([^"]*)"/)?.[1];
    const type = m[0].match(/type="([^"]*)"/)?.[1];
    if (field) nameByTag.set(tag, unescapeXml(field));
    if (type) typeByTag.set(tag, type);
  }
  const NUM_TYPE = /int|long|short|decimal|double|float/i;
  // Columns come FROM THE SCHEMA, not from the first row: NULL cells (e.g. a measure of
  // another fact table that is empty on this row) are simply absent from <row>, so
  // reading columns from rows would lose such columns entirely.
  const columns = Array.from(nameByTag.values());
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<([^\s/>]+)([^>]*)>([\s\S]*?)<\/\1>/g;
  for (let rm; (rm = rowRe.exec(xml)); ) {
    const row = {};
    for (const c of columns) row[c] = null;
    for (let cm; (cm = cellRe.exec(rm[1])); ) {
      const tag = cm[1];
      const name = nameByTag.get(tag) ?? tag;
      const raw = unescapeXml(cm[3]);
      const type = cm[2].match(/xsi:type="([^"]*)"/)?.[1] ?? typeByTag.get(tag) ?? '';
      row[name] = NUM_TYPE.test(type) ? Number(raw) : raw;
      if (!columns.includes(name)) columns.push(name);
    }
    rows.push(row);
  }
  return { columns, rows };
}
// ⚠️ CONCURRENCY LIMIT. msmdpump/IIS answers "HTTP 503" when one page fires a dozen requests at
// once. Keep at most OLAP_MAX_PARALLEL requests in flight and retry a 5xx once after a pause —
// by then the cube is usually free again.
const MAX_PARALLEL = Number(process.env.OLAP_MAX_PARALLEL) || 3;
let running = 0;
const waiting = [];
async function acquire() {
  if (running < MAX_PARALLEL) {
    running++;
    return;
  }
  await new Promise(resolve => waiting.push(resolve));
  running++;
}
function release() {
  running--;
  waiting.shift()?.();
}
async function post(statement, catalog) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: '"urn:schemas-microsoft-com:xml-analysis:Execute"',
        Authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`,
      },
      body: envelope(statement, catalog),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OLAP HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}
/** Runs a DAX query against the cube. Returns rows as "column name → value" objects. */
export async function dax(statement, catalog = CATALOG) {
  if (!URL_ || !PASS || !catalog) throw new Error(NOT_CONFIGURED);
  await acquire();
  try {
    try {
      return parseRowset(await post(statement, catalog)).rows;
    } catch (e) {
      if (!/HTTP 50[0-9]/.test(String(e?.message))) throw e;
      await new Promise(r => setTimeout(r, 1500));
      return parseRowset(await post(statement, catalog)).rows;
    }
  } finally {
    release();
  }
}
/** Escapes a DAX string literal (double quotes are doubled). */
export const daxStr = s => `"${String(s).replace(/"/g, '""')}"`;
/** Literal list for filters: {"a","b"} — for TREATAS/IN. */
export const daxList = values => `{${values.map(daxStr).join(',')}}`;
/** Short column name: 'Спр - Номенклатура[Код]' → 'Код'; '[# Выручка]' → '# Выручка'. */
export function shortName(col) {
  const m = col.match(/\[([^\]]+)\]\s*$/);
  return m ? m[1] : col;
}
/** Whether the cube is reachable (for the "data from cube" badge and graceful degradation of sections). */
export async function olapHealth() {
  try {
    await dax('EVALUATE ROW("ok", 1)');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}
