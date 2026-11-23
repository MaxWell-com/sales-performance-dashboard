// Deterministic random numbers for demo data — no dependencies.
//
// rng(seed) — sequential generator (mulberry32): same seed → same sequence.
// keyed(...parts) — a "random" number that depends only on the key (hash), not on call order:
// the "Client agent" API uses it so a client card does not depend on what was requested before it.

export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    /** uniform on [a, b) */
    uni: (a2, b) => a2 + (b - a2) * next(),
    /** integer on [a, b] */
    int: (a2, b) => a2 + Math.floor(next() * (b - a2 + 1)),
    chance: p => next() < p,
    pick: arr => arr[Math.floor(next() * arr.length)],
    /** standard normal N(0,1), Box–Muller */
    normal: () => {
      const u = Math.max(next(), 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
    /** log-normal multiplier with mean 1 */
    lognorm: sigma => Math.exp(sigma * r.normal() - (sigma * sigma) / 2),
    /** index chosen by weights */
    weighted: weights => {
      let total = 0;
      for (const w of weights) total += w;
      let x = next() * total;
      for (let i = 0; i < weights.length; i++) {
        x -= weights[i];
        if (x < 0) return i;
      }
      return weights.length - 1;
    },
    /** k distinct elements, probability proportional to weight */
    sampleWeighted: (arr, weightOf, k) => {
      const pool = arr.map(x => ({ x, w: weightOf(x) })).filter(o => o.w > 0);
      // Efraimidis–Spirakis: key u^(1/w), take the k largest
      for (const o of pool) o.key = Math.pow(Math.max(next(), 1e-12), 1 / o.w);
      pool.sort((p, q) => q.key - p.key);
      return pool.slice(0, k).map(o => o.x);
    },
  };
  return r;
}

/** 32-bit hash of a list of numbers/strings. */
export function hash32(...parts) {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x7c;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic number on [0, 1) for a key. */
export const keyed = (...parts) => rng(hash32(...parts)).next();
