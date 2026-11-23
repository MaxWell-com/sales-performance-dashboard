// Data source selection — the single place in the app where it happens.
//
//   DATA_SOURCE=demo (default) — synthetic data for the fictional manufacturer NORD,
//                                no infrastructure required (src/demo);
//   DATA_SOURCE=olap           — OLAP cube (SSAS Tabular, DAX via XMLA) and DWH (MS SQL),
//                                configured via environment variables (see .env.example).
//
// A source is an object with a common interface (src/sources/*.js):
//   buildSnapshot({ prev })                       → { json, meta, forecast, forecastInfo }
//   customer.getCustomerOverview(from, to)         → "Client agent" overview
//   customer.getCustomerStructure(scope, unit, from, to)
//   customer.getCustomerProfile(id, from, to)
//   clientStock({ code, name, from, to })          → client-side stock
// The source module is loaded lazily: in demo mode the cube and DWH drivers are never imported.
const SOURCES = {
  demo: () => import('./sources/demo.js'),
  olap: () => import('./sources/olap.js'),
};

export const DATA_SOURCE = (process.env.DATA_SOURCE || 'demo').trim().toLowerCase();
if (!SOURCES[DATA_SOURCE]) {
  throw new Error(`DATA_SOURCE="${DATA_SOURCE}" is not supported; allowed: ${Object.keys(SOURCES).join(', ')}`);
}

let loading = null;
/** The data source selected by DATA_SOURCE. */
export function getSource() {
  loading ??= SOURCES[DATA_SOURCE]().then(m => m.default);
  return loading;
}
