// Server smoke test on demo data: liveness, page with data, "Client agent" API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_SOURCE = 'demo';
delete process.env.REQUIRED_TEAM;
const { createApp, buildInBackground } = await import('../src/app.js');
const { requireAuth } = await import('../src/auth.js');

let server;
let base;
before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await buildInBackground();
});
after(() => server.close());

const get = async (path, init) => {
  const res = await fetch(base + path, init);
  return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
};
const json = async path => {
  const r = await get(path);
  assert.equal(r.status, 200, `${path}: ${r.text.slice(0, 200)}`);
  return JSON.parse(r.text);
};

test('GET /health', async () => {
  assert.deepEqual(await json('/health'), { status: 'ok' });
});

test('GET / serves the dashboard with the snapshot injected', async () => {
  const r = await get('/', { headers: { Accept: 'text/html' } });
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.ok(!r.text.includes('__DASH_DATA__'), 'data placeholder replaced');
  const m = r.text.match(/const DATA=(\{.*?\});\r?\n/s);
  assert.ok(m, 'data injected into the template');
  const data = JSON.parse(m[1].replace(/\\u003c/g, '<'));
  assert.equal(data.lastYM, 202610);
  assert.ok(data.sales.length > 100000);
});

test('GET /api/report/sales/meta', async () => {
  const m = await json('/api/report/sales/meta');
  assert.equal(m.ok, true);
  assert.equal(m.source, 'demo');
  assert.equal(m.meta.lastYM, 202610);
});

test('customer agent API: overview, profile, structure, client stock', async () => {
  const ov = await json('/api/profiles/customer/overview?from=2026-01&to=2026-10');
  assert.ok(ov.rows.length > 250);
  assert.ok(ov.meta.totalSales > 0 && ov.meta.withPlan > 0);
  assert.ok(ov.rows.some(r => !r.hasFact && r.id.startsWith('name:')), 'there are plan-only clients');

  const top = ov.rows.find(r => r.hasFact && r.hasPlan);
  const p = await json(`/api/profiles/customer/${encodeURIComponent(top.id)}?from=2026-01&to=2026-10`);
  assert.equal(p.passport.name, top.name);
  assert.ok(p.salesItems.length > 0 && p.salesItems[0].months.length > 0);
  assert.ok(p.planTotal > 0 && p.standing.rank > 0);
  assert.ok(p.bindings.depts.length > 0 && p.bindings.freq.length > 0);
  const salesSum = p.salesItems.reduce((t, it) => t + it.months.reduce((s, m) => s + m.rev, 0), 0);
  assert.ok(Math.abs(salesSum - top.sales) < 1, 'client card matches the overview');

  const planOnly = ov.rows.find(r => !r.hasFact);
  const po = await json(`/api/profiles/customer/${encodeURIComponent(planOnly.id)}?from=2026-01&to=2026-10`);
  assert.equal(po.passport.code, null);
  assert.equal(po.salesItems.length, 0);

  const unit = p.bindings.depts[0].name;
  const st = await json(`/api/profiles/customer/structure?scope=dept&unit=${encodeURIComponent(unit)}&from=2026-01&to=2026-10`);
  assert.ok(st.brands.length > 5 && st.total > 0);
  assert.ok(Math.abs(st.brands.reduce((s, b) => s + b.share, 0) - 1) < 1e-9);

  const sources = new Set();
  for (const r of ov.rows.slice(0, 40)) {
    const s = await json(`/api/report/sales/client-stock?code=${encodeURIComponent(r.id)}&name=${encodeURIComponent(r.name)}`);
    if (s.available) sources.add(s.source);
  }
  assert.deepEqual([...sources].sort(), ['chain', 'sellout']);

  assert.equal((await get('/api/profiles/customer/unknown-id')).status, 404);
  assert.equal((await get('/api/profiles/customer/structure?scope=x&unit=y')).status, 400);
});

test('POST /api/report/sales/refresh and guide', async () => {
  assert.equal((await get('/api/report/sales/refresh', { method: 'POST' })).status, 202);
  const g = await get('/api/report/sales/guide');
  assert.equal(g.status, 200);
  assert.match(g.type, /text\/html/);
});

test('identity: proxy headers when present, otherwise "local"', () => {
  const run = headers => {
    const req = { headers };
    requireAuth(req, null, () => {});
    return req.user;
  };
  assert.deepEqual(run({}), { email: null, login: 'local', teams: [] });
  assert.deepEqual(run({ 'x-auth-request-email': 'a@example.com', 'x-auth-request-groups': 'org,/org:team' }), {
    email: 'a@example.com',
    login: 'a@example.com',
    teams: ['org', 'org:team'],
  });
});
