// Client-side stock route for the "Client agent" tab: GET /api/report/sales/client-stock
// ?code=<client code>&name=<name>&from=YYYY-MM&to=YYYY-MM. Data comes from the source (src/dataSource.js).
// Response: { available: true, source: 'chain' | 'sellout', … } or { available: false[, error] } —
// in the latter case the tab opens without the stock block.
import { getSource } from '../dataSource.js';

export async function clientStockHandler(req, res) {
  const str = v => (typeof v === 'string' ? v : '');
  const q = { code: str(req.query.code), name: str(req.query.name), from: str(req.query.from), to: str(req.query.to) };
  try {
    const source = await getSource();
    res.json(await source.clientStock(q));
  } catch (e) {
    console.error('[client-stock]', e);
    res.json({ available: false, error: String(e?.message ?? e).slice(0, 200) });
  }
}
