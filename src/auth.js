// User identity.
//
// When the app runs behind an SSO proxy (e.g. oauth2-proxy), identity arrives in the
// X-Auth-Request-Email / -User / -Preferred-Username / -Groups headers. Without them the user is
// "local": the demo and local runs need no authentication at all.
//
// ⚠️ These headers are trustworthy only if the app cannot be reached bypassing the proxy (the proxy
// overwrites them itself). Group restriction (REQUIRED_TEAM) only makes sense in that setup.
const header = (req, name) => {
  const v = req.headers[name];
  return typeof v === 'string' ? v.trim() : '';
};

export function requireAuth(req, _res, next) {
  const email = header(req, 'x-auth-request-email');
  const login = header(req, 'x-auth-request-preferred-username') || header(req, 'x-auth-request-user') || email;
  const teams = header(req, 'x-auth-request-groups')
    .split(',')
    .map(t => t.trim().replace(/^\//, ''))
    .filter(Boolean);
  req.user = { email: email || null, login: login || 'local', teams };
  next();
}

/** Allows access if the user has any of the groups; an empty list means open access. */
export function hasTeam(user, teams) {
  return !teams.length || teams.some(t => user?.teams?.includes(t));
}
