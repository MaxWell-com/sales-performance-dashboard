// Customer profile API for the "Client agent" tab.
//
//   GET /api/profiles/customer/overview?from=&to=          — client list: sales + plan
//   GET /api/profiles/customer/structure?scope=&unit=&…    — purchase mix of a comparison scope
//   GET /api/profiles/customer/:id?from=&to=               — client card
//
// The client id is its code, or "name:<name>" for a client that exists only in the plan.
// Data comes from the source (src/dataSource.js): demo model or OLAP cube.
import { getSource } from '../dataSource.js';

export function registerCustomerRoutes(app) {
  const customer = async () => (await getSource()).customer;

  // ⚠️ Must be registered before `/:id`, otherwise "overview" is captured as a client id.
  app.get('/api/profiles/customer/overview', async (req, res) => {
    try {
      const from = String(req.query.from ?? '');
      const to = String(req.query.to ?? '');
      res.json(await (await customer()).getCustomerOverview(from || undefined, to || undefined));
    } catch (e) {
      console.error('[profiles/customer/overview]', e);
      res.status(500).json({ error: 'Ошибка загрузки сводки по покупателям' });
    }
  });

  // ⚠️ Must be registered before `/:id`, otherwise "structure" is captured as a client id.
  app.get('/api/profiles/customer/structure', async (req, res) => {
    try {
      const scope = String(req.query.scope ?? '');
      const unit = String(req.query.unit ?? '');
      const from = String(req.query.from ?? '');
      const to = String(req.query.to ?? '');
      const st = await (await customer()).getCustomerStructure(scope, unit, from, to);
      if (!st) return res.status(400).json({ error: 'Не задан масштаб или единица сравнения' });
      res.json(st);
    } catch (e) {
      console.error('[profiles/customer/structure]', e);
      res.status(500).json({ error: 'Ошибка загрузки структуры масштаба' });
    }
  });

  app.get('/api/profiles/customer/:id', async (req, res) => {
    try {
      const from = String(req.query.from ?? '');
      const to = String(req.query.to ?? '');
      const profile = await (await customer()).getCustomerProfile(String(req.params.id), from, to);
      if (!profile) return res.status(404).json({ error: 'Клиент не найден' });
      res.json(profile);
    } catch (e) {
      console.error('[profiles/customer]', e);
      res.status(500).json({ error: 'Ошибка загрузки профиля покупателя' });
    }
  });
}
