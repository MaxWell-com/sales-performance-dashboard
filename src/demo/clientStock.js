// Client-side stock for the "Client agent" tab in demo mode. Two response formats:
//   - source 'chain'   — problem (stuck) stock of a key or regional retail chain;
//   - source 'sellout' — distributor stock and sell-out by product.
// Other clients get { available: false }: no stock data for them.
// Figures are derived deterministically from the client's purchases over the last six months.
import { getDemoModel, ymAdd, daysIn } from './model.js';
import { rng, hash32 } from './random.js';
import * as C from './catalog.js';

const ymKey = ym => `${Math.floor(ym / 100)}-${String(ym % 100).padStart(2, '0')}`;
const CHAIN_KINDS = new Set(['key', 'keyKids', 'chain']);

/** Client's average purchases over the 6 months up to the cut-off: item → units/month. */
function recentQty(M, pi) {
  const from = ymAdd(M.lastYM, -5);
  const q = new Map();
  for (const i of M.salesByPartner[pi]) {
    const s = M.sales[i];
    if (s[3] >= from) q.set(s[0], (q.get(s[0]) || 0) + s[5] / 6);
  }
  return q;
}

function chainStock(M, pi) {
  const p = M.partners[pi];
  const r = rng(hash32('chain-stock', p.code));
  const q = Array.from(recentQty(M, pi)).filter(([, v]) => v > 0);
  const n = Math.min(q.length, r.int(8, 24));
  const items = [];
  for (let k = 0; k < n; k++) {
    const j = k + Math.floor(r.next() * (q.length - k));
    [q[k], q[j]] = [q[j], q[k]];
    const [itId, mq] = q[k];
    const it = M.items[itId];
    const stock = Math.max(1, Math.round(mq * r.uni(0.4, 2.8)));
    const rub = Math.round(stock * it.price0 * it.priceIdx[Math.floor(M.lastYM / 100)] * (1 - p.disc));
    const stores = Math.round(p.size / 1e5);
    items.push({
      code: it.code,
      name: it.name,
      brand: it.trademark,
      stock,
      rub,
      problemRub: Math.round(rub * r.uni(0.25, 1)),
      storesStuck: r.int(2, Math.max(3, Math.round(stores * 0.4))),
      storesActive: r.int(Math.max(5, Math.round(stores * 0.3)), Math.max(10, stores)),
    });
  }
  items.sort((a, b) => b.problemRub - a.problemRub);
  return {
    available: true,
    source: 'chain',
    asOf: `${ymKey(M.lastYM)}-${String(daysIn(M.lastYM) - 4).padStart(2, '0')}`,
    totalStockQty: items.reduce((t, x) => t + x.stock, 0),
    totalStockRub: items.reduce((t, x) => t + x.rub, 0),
    problemRub: items.reduce((t, x) => t + x.problemRub, 0),
    items,
    note: 'Проблемный (зависший) сток сети: медленные и непродающиеся позиции, не весь ассортимент.',
  };
}

function distributorStock(M, pi) {
  const p = M.partners[pi];
  const r = rng(hash32('sellout', p.code));
  const items = [];
  for (const [itId, mq] of recentQty(M, pi)) {
    const it = M.items[itId];
    const kind = r.weighted([0.12, 0.6, 0.2, 0.08]); // shortage / normal / overstock / dead stock
    const sellout = kind === 3 ? 0 : Math.round(mq * r.uni(0.7, 1.15));
    const stock = Math.round(
      kind === 0 ? sellout * r.uni(0, 0.4) : kind === 1 ? sellout * r.uni(0.8, 2.2) : kind === 2 ? sellout * r.uni(3, 7) : mq * r.uni(1, 4),
    );
    const avgMonthly = sellout * r.uni(0.9, 1.1);
    items.push({
      code: it.code,
      stock,
      sellout,
      avgMonthly,
      coverMonths: avgMonthly > 0 ? stock / avgMonthly : stock > 0 ? null : 0,
    });
  }
  items.sort((a, b) => b.stock - a.stock);
  const cities = [C.REGION_CITY[p.t2], ...(C.GEO[p.t1] || []).map(reg => C.REGION_CITY[reg])].filter(Boolean);
  const points = Array.from(new Set(cities)).slice(0, r.int(1, 3)).map(c => `Склад ${c}`);
  return {
    available: true,
    source: 'sellout',
    asOf: ymKey(M.lastYM),
    totalStockQty: items.reduce((t, x) => t + x.stock, 0),
    totalSelloutQty: items.reduce((t, x) => t + x.sellout, 0),
    points,
    items,
  };
}

/** { code, name } → response of /api/report/sales/client-stock. */
export async function getClientStock({ code, name }) {
  const M = getDemoModel();
  let pi = code ? M.partners.findIndex(p => p.code === code) : -1;
  if (pi < 0 && name) pi = M.partners.findIndex(p => p.name.toLowerCase() === name.trim().toLowerCase());
  if (pi < 0) return { available: false };
  const p = M.partners[pi];
  if (p.end || p.planOnly) return { available: false };
  if (CHAIN_KINDS.has(p.kind)) return chainStock(M, pi);
  if (p.kind === 'distr') return distributorStock(M, pi);
  return { available: false };
}
