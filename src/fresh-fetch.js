// fresh-fetch.js
// Outbound HTTPS requests to third-party APIs (Notion, Anthropic) consistently
// fail with "Premature close" on Railway's network — both undici (Node's
// built-in fetch) and node-fetch hit it identically, which points to a
// reused keep-alive socket going stale rather than a fetch-library bug.
// Forcing a fresh connection per request (keepAlive: false) is the standard
// fix for this class of issue on containerized/proxied platforms.

const https = require('https');
const nodeFetch = require('node-fetch');

const freshConnectionAgent = new https.Agent({ keepAlive: false });

function fetchWithFreshConnection(url, opts = {}) {
  return nodeFetch(url, { ...opts, agent: freshConnectionAgent });
}

module.exports = { fetchWithFreshConnection };
