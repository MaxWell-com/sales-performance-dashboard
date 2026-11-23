// Entry point: HTTP server and snapshot warm-up. The app is src/app.js, the data source is
// src/dataSource.js (DATA_SOURCE=demo by default: runs without any infrastructure).
import { createApp, buildInBackground } from './app.js';
import { DATA_SOURCE } from './dataSource.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

createApp().listen(PORT, HOST, () => {
  console.log(`[app] data source: ${DATA_SOURCE}; listening on http://${HOST}:${PORT}`);
  // Warm-up: start building the snapshot right after startup, without waiting for the first visitor.
  buildInBackground();
});
