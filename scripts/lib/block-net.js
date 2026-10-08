'use strict';
// Test helper, preloaded into the server test/server.test.js starts (node -r): every outbound fetch
// that isn't to this machine fails, so no test can reach a geocoder, the
// Overpass mirrors, Anthropic, a sales sheet or your field app.
const orig = global.fetch;
global.fetch = async (url, opts) => {
  const u = new URL(typeof url === 'string' ? url : url.url || String(url));
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return orig(url, opts);
  throw new Error(`network blocked in tests: ${u.hostname}`);
};
