// Minimal Google Sheets client: a service-account JWT signed with Node's
// crypto and plain REST calls. Avoids pulling in the Google SDK for what is
// two endpoints.

const crypto = require('crypto');
const { fetchWithFreshConnection } = require('../../fresh-fetch');

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const b64url = input => Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

// Accepts the raw JSON key or the same thing base64-encoded (easier to paste
// into an env var without escaping newlines).
function loadServiceAccount() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const account = JSON.parse(json);
  if (!account.client_email || !account.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key');
  return account;
}

async function getAccessToken({ readOnly = true } = {}) {
  const account = loadServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: account.client_email,
    scope: `https://www.googleapis.com/auth/spreadsheets${readOnly ? '.readonly' : ''}`,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(account.private_key);
  const res = await fetchWithFreshConnection('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${header}.${claims}.${b64url(signature)}`,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Google auth failed: ${body.error_description || body.error || res.status}`);
  return { token: body.access_token, email: account.client_email };
}

async function call(token, url, { method = 'GET', body } = {}) {
  const res = await fetchWithFreshConnection(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${data.error?.message || res.statusText}`);
  return data;
}

async function listTabs(token, sheetId) {
  const data = await call(token, `${SHEETS}/${sheetId}?fields=sheets.properties(sheetId,title)`);
  return (data.sheets || []).map(s => s.properties);
}

// Unformatted values, with dates as serial numbers, so a date cell reads the
// same whatever display format the sheet uses.
async function readTabs(token, sheetId, titles) {
  const ranges = titles.map(t => `ranges=${encodeURIComponent(`'${t.replace(/'/g, "''")}'`)}`).join('&');
  const data = await call(token,
    `${SHEETS}/${sheetId}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
  return (data.valueRanges || []).map(r => r.values || []);
}

async function replaceTab(token, sheetId, title, rows) {
  const tabs = await listTabs(token, sheetId);
  if (!tabs.some(t => t.title === title)) {
    await call(token, `${SHEETS}/${sheetId}:batchUpdate`, { method: 'POST', body: { requests: [{ addSheet: { properties: { title } } }] } });
  }
  const range = encodeURIComponent(`'${title}'`);
  await call(token, `${SHEETS}/${sheetId}/values/${range}:clear`, { method: 'POST', body: {} });
  await call(token, `${SHEETS}/${sheetId}/values/${range}?valueInputOption=RAW`, { method: 'PUT', body: { values: rows } });
}

module.exports = { getAccessToken, listTabs, readTabs, replaceTab };
