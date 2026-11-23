// Snapshot cache for the sales dashboard.
//
// The snapshot is built by the data source (src/dataSource.js): demo generator or OLAP cube + DWH.
// The snapshot shape is the same for all sources (report/snapshotCore.js). It lives in process
// memory with a TTL; concurrent build requests are coalesced into one.
import { getSource } from '../dataSource.js';

const TTL_MS = Number(process.env.REPORT_SALES_TTL_MS) || 6 * 3600 * 1000;
let cache = null;
let inflight = null;

export async function getSnapshot(force = false) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const source = await getSource();
      // prev — the last successful snapshot: the source may reuse parts of it that failed to load now
      const built = await source.buildSnapshot({ prev: cache });
      cache = { ...built, at: Date.now() };
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Returns the cached snapshot immediately (or null) without triggering a build — for graceful degradation. */
export function cachedSnapshot() {
  return cache;
}
