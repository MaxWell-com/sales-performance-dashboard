// Sales performance dashboard — Express application.
//
// Server-rendered: the data source (src/dataSource.js: demo generator or OLAP cube + DWH) builds a
// data snapshot, the server injects it into a self-contained HTML template and serves one page.
// The "Client agent" tab lazily requests the client profile and client-side stock from the same source.
// There is no client-side build — see src/view.js and src/report/.
import express from 'express';
import { requireAuth, hasTeam } from './auth.js';
import { DATA_SOURCE } from './dataSource.js';
import { getSnapshot, cachedSnapshot } from './report/snapshot.js';
import { clientStockHandler } from './report/clientStock.js';
import { registerCustomerRoutes } from './profiles/customerRoutes.js';
import { renderReport, renderBuilding, renderError, renderForbidden, renderGuide } from './view.js';

// Comma-separated groups allowed to view the report; any one is enough. Empty (default) — open access.
const REQUIRED_TEAMS = (process.env.REQUIRED_TEAM || '')
  .split(',')
  .map(t => t.trim())
  .filter(Boolean);
// Snapshot TTL: a stale snapshot is served immediately while a fresh one is built in the background.
const TTL_MS = Number(process.env.REPORT_SALES_TTL_MS) || 6 * 3600 * 1000;

// Build state — for the placeholder page and /meta.
let building = null;
let buildStartedAt = null;
let lastError = null;

/**
 * Starts a background snapshot build; never throws. Users never wait for a build:
 * the page shows either a ready (possibly slightly stale) snapshot or a placeholder.
 */
export function buildInBackground({ force = false } = {}) {
  if (building) return building;
  buildStartedAt = Date.now();
  building = getSnapshot(force)
    .then(snapshot => {
      lastError = null;
      return snapshot;
    })
    .catch(err => {
      lastError = String(err?.message ?? err);
      console.error('[report] snapshot build failed:', err);
      return null;
    })
    .finally(() => {
      building = null;
      buildStartedAt = null;
    });
  return building;
}

/** Snapshot is stale — refresh it (the old one is still served until the new one is ready). */
const isStale = snapshot => Date.now() - snapshot.at >= TTL_MS;

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // No body parser on purpose: no route reads a request body.

  // Liveness probe. Touches neither the source nor the snapshot: the container is healthy even with a cold cache.
  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
  // There is no favicon; browsers request it anyway — answer 204 instead of 404.
  app.get('/favicon.ico', (_req, res) => res.status(204).end());

  app.use(requireAuth);
  if (REQUIRED_TEAMS.length) {
    // Browsers get a styled "access denied" page, everything else (fetch) gets JSON.
    app.use((req, res, next) => {
      if (hasTeam(req.user, REQUIRED_TEAMS)) return next();
      if ((req.headers.accept || '').includes('text/html')) {
        return res.status(403).type('html').send(renderForbidden(REQUIRED_TEAMS.join(' или '), req.user?.email));
      }
      res.status(403).json({ error: `Нужна группа ${REQUIRED_TEAMS.join(' или ')}` });
    });
  }

  // The report. Placeholder until the first snapshot exists; stale snapshots are refreshed in the background.
  function sendReport(_req, res) {
    const snapshot = cachedSnapshot();
    if (!snapshot) {
      buildInBackground();
      if (lastError) return res.status(200).type('html').send(renderError(lastError));
      return res
        .status(200)
        .type('html')
        .send(
          renderBuilding({
            startedAt: buildStartedAt,
            elapsedSec: buildStartedAt ? (Date.now() - buildStartedAt) / 1000 : 0,
          }),
        );
    }
    if (isStale(snapshot)) buildInBackground();
    res.type('html').send(renderReport(snapshot));
  }
  app.get('/', sendReport);
  app.get('/api/report/sales/view', sendReport);

  // Snapshot metadata: coverage, build time, state — without downloading the whole page.
  app.get('/api/report/sales/meta', (_req, res) => {
    const snapshot = cachedSnapshot();
    res.json({
      ok: !!snapshot,
      source: DATA_SOURCE,
      meta: snapshot?.meta ?? null,
      builtAt: snapshot ? new Date(snapshot.at).toISOString() : null,
      stale: snapshot ? isStale(snapshot) : null,
      building: !!building,
      error: lastError,
    });
  });

  // Forced rebuild. Responds immediately: the build runs in the background, state is visible in /meta.
  app.post('/api/report/sales/refresh', (_req, res) => {
    buildInBackground({ force: true });
    res.status(202).json({ ok: true, message: 'Пересборка снимка запущена' });
  });

  // User guide (the "Help" button in the report header).
  app.get('/api/report/sales/guide', (_req, res) => res.type('html').send(renderGuide()));

  // "Client agent" tab: client-side stock and client profile.
  app.get('/api/report/sales/client-stock', clientStockHandler);
  registerCustomerRoutes(app);

  app.use((err, _req, res, _next) => {
    console.error('[app]', err);
    res
      .status(500)
      .type('html')
      .send(renderError(err?.message ?? String(err)));
  });
  return app;
}
