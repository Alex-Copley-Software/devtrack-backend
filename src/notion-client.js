// notion-client.js
// Notion API wrapper: page fetch/update, database schema caching, and
// per-database property-name mapping (title/status/assignee/priority/dueDate).

const https = require('https');
const { Client } = require('@notionhq/client');
const nodeFetch = require('node-fetch');

// Requests to api.notion.com consistently fail with "Premature close" on
// Railway's network — both undici (Node's built-in fetch) and node-fetch hit
// it identically, which points to a reused keep-alive socket going stale
// rather than a fetch-library bug. Forcing a fresh connection per request
// (keepAlive: false) is the standard fix for this class of issue on
// containerized/proxied platforms.
const freshConnectionAgent = new https.Agent({ keepAlive: false });
function fetchWithFreshConnection(url, opts = {}) {
  return nodeFetch(url, { ...opts, agent: freshConnectionAgent });
}

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.NOTION_API_KEY) throw new Error('NOTION_API_KEY is not set');
    client = new Client({ auth: process.env.NOTION_API_KEY, fetch: fetchWithFreshConnection });
  }
  return client;
}

function normalizeId(id) {
  return String(id || '').replace(/-/g, '');
}

// Notion API calls occasionally fail with transient network errors (e.g.
// "Premature close" on some hosting networks). Retries a few times with a
// short backoff before giving up; non-transient errors (bad request, auth,
// not found) are rethrown immediately.
const TRANSIENT_ERROR_PATTERN = /premature close|econnreset|socket hang up|fetch failed|etimedout|network/i;
async function withRetry(fn, { attempts = 3, delayMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT_ERROR_PATTERN.test(err.message || '') || i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

function getKnownDatabaseIds() {
  return String(process.env.NOTION_DATABASE_ID || process.env.NOTION_DATABASE_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function isKnownDatabase(databaseId) {
  const norm = normalizeId(databaseId);
  return getKnownDatabaseIds().some(id => normalizeId(id) === norm);
}

// Explicit property-name map for databases we know about. Falls back to
// type-based auto-detection (see resolvePropertyNames) for anything else.
const DB_PROPERTY_MAP = {
  // Assets Tracker
  '2e225458690f809b99f4d1d7495d9219': {
    title: 'Name',
    status: 'Status',
    assignee: 'Assigned to',
    priority: 'Priority',
    dueDate: 'Due Date',
  },
};

const schemaCache = new Map(); // databaseId -> { schema, fetchedAt }
const SCHEMA_CACHE_MS = 5 * 60 * 1000;

async function getDatabaseSchema(databaseId) {
  const norm = normalizeId(databaseId);
  const cached = schemaCache.get(norm);
  if (cached && Date.now() - cached.fetchedAt < SCHEMA_CACHE_MS) return cached.schema;
  const schema = await withRetry(() => getClient().databases.retrieve({ database_id: databaseId }));
  schemaCache.set(norm, { schema, fetchedAt: Date.now() });
  return schema;
}

// Best-effort auto-detection for databases without an explicit entry above.
function autoDetectPropertyNames(schema) {
  const props = schema.properties || {};
  const entries = Object.entries(props);
  const names = {};
  const titleEntry = entries.find(([, p]) => p.type === 'title');
  if (titleEntry) names.title = titleEntry[0];
  const statusEntry = entries.find(([n, p]) => (p.type === 'status' || p.type === 'select') && /status/i.test(n));
  if (statusEntry) names.status = statusEntry[0];
  const assigneeEntry = entries.find(([n, p]) =>
    ['people', 'multi_select', 'select', 'rich_text'].includes(p.type) && /assign|owner/i.test(n)
  );
  if (assigneeEntry) names.assignee = assigneeEntry[0];
  const priorityEntry = entries.find(([n, p]) => ['select', 'multi_select'].includes(p.type) && /priority/i.test(n));
  if (priorityEntry) names.priority = priorityEntry[0];
  const dueDateEntry = entries.find(([n, p]) => p.type === 'date' && /due/i.test(n));
  if (dueDateEntry) names.dueDate = dueDateEntry[0];
  return names;
}

async function resolvePropertyNames(databaseId) {
  const norm = normalizeId(databaseId);
  if (DB_PROPERTY_MAP[norm]) return DB_PROPERTY_MAP[norm];
  const schema = await getDatabaseSchema(databaseId);
  return autoDetectPropertyNames(schema);
}

// Returns the raw option names for the assignee property (multi_select/select/status),
// used to populate the admin nickname-mapping dropdown.
async function getAssigneeOptions(databaseId) {
  const names = await resolvePropertyNames(databaseId);
  if (!names.assignee) return [];
  const schema = await getDatabaseSchema(databaseId);
  const prop = schema.properties?.[names.assignee];
  if (!prop) return [];
  if (prop.type === 'multi_select') return (prop.multi_select?.options || []).map(o => o.name);
  if (prop.type === 'select') return (prop.select?.options || []).map(o => o.name);
  if (prop.type === 'status') return (prop.status?.options || []).map(o => o.name);
  return [];
}

function plainTextOf(richTextArray) {
  return (richTextArray || []).map(t => t.plain_text).join('');
}

function extractPropertyValue(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case 'title': return plainTextOf(prop.title) || null;
    case 'status': return prop.status?.name || null;
    case 'select': return prop.select?.name || null;
    case 'multi_select': return (prop.multi_select || []).map(o => o.name);
    case 'people': return (prop.people || []).map(p => p.name).filter(Boolean);
    case 'rich_text': return plainTextOf(prop.rich_text) || null;
    case 'date': return prop.date?.start || null;
    default: return null;
  }
}

// Normalizes a full Notion page object (from either pages.retrieve or
// databases.query results — both include full `properties`) into the fields
// we care about for the NotionTask table.
async function extractFieldsFromPage(page, databaseId) {
  const names = await resolvePropertyNames(databaseId);
  const props = page.properties || {};

  const title = names.title ? (extractPropertyValue(props[names.title]) || 'Untitled') : 'Untitled';
  const status = names.status ? extractPropertyValue(props[names.status]) : null;
  let assigneeNicknames = names.assignee ? extractPropertyValue(props[names.assignee]) : null;
  if (assigneeNicknames && !Array.isArray(assigneeNicknames)) assigneeNicknames = [assigneeNicknames];
  const priorityRaw = names.priority ? extractPropertyValue(props[names.priority]) : null;
  const priority = Array.isArray(priorityRaw) ? (priorityRaw[0] || null) : priorityRaw;
  const dueDate = names.dueDate ? extractPropertyValue(props[names.dueDate]) : null;

  return {
    databaseId,
    title,
    status: status || 'Not started',
    assigneeNicknames: assigneeNicknames || [],
    priority,
    dueDate,
    notionLastEditedTime: page.last_edited_time,
    notionUrl: page.url,
  };
}

// Fetches a single full page (webhook payloads are sparse) and normalizes
// it. Returns the resolved databaseId too, since webhook payloads don't
// reliably include it.
async function fetchTaskFields(pageId) {
  const page = await withRetry(() => getClient().pages.retrieve({ page_id: pageId }));
  if (page.parent?.type !== 'database_id') {
    return { databaseId: null, page };
  }
  return extractFieldsFromPage(page, page.parent.database_id);
}

// Queries every page currently in a database (paginated) and normalizes
// each — used for the initial/manual backfill so existing Notion cards
// don't require an individual edit to trigger a webhook before they sync.
async function fetchAllTaskFieldsInDatabase(databaseId) {
  const results = [];
  let cursor;
  do {
    const res = await withRetry(() => getClient().databases.query({ database_id: databaseId, start_cursor: cursor, page_size: 100 }));
    for (const page of res.results) {
      results.push({ pageId: page.id, fields: await extractFieldsFromPage(page, databaseId) });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

// Writes changes back to a Notion page. `changes` may include title, status,
// assigneeNicknames (array of Notion option names, already resolved from user IDs).
async function updateNotionPage(pageId, databaseId, changes) {
  const names = await resolvePropertyNames(databaseId);
  const properties = {};

  if (changes.title !== undefined && names.title) {
    properties[names.title] = { title: [{ text: { content: String(changes.title) } }] };
  }
  if (changes.status !== undefined && names.status) {
    const schema = await getDatabaseSchema(databaseId);
    const propType = schema.properties?.[names.status]?.type;
    properties[names.status] = propType === 'select'
      ? { select: { name: changes.status } }
      : { status: { name: changes.status } };
  }
  if (changes.assigneeNicknames !== undefined && names.assignee) {
    const schema = await getDatabaseSchema(databaseId);
    const propType = schema.properties?.[names.assignee]?.type;
    if (propType === 'multi_select') {
      properties[names.assignee] = { multi_select: changes.assigneeNicknames.map(name => ({ name })) };
    } else if (propType === 'select') {
      properties[names.assignee] = { select: changes.assigneeNicknames[0] ? { name: changes.assigneeNicknames[0] } : null };
    }
  }
  if (changes.priority !== undefined && names.priority) {
    const schema = await getDatabaseSchema(databaseId);
    const propType = schema.properties?.[names.priority]?.type;
    if (propType === 'multi_select') {
      properties[names.priority] = { multi_select: changes.priority ? [{ name: changes.priority }] : [] };
    } else if (propType === 'select') {
      properties[names.priority] = { select: changes.priority ? { name: changes.priority } : null };
    }
  }

  if (!Object.keys(properties).length) return null;

  const updated = await withRetry(() => getClient().pages.update({ page_id: pageId, properties }));
  return { notionLastEditedTime: updated.last_edited_time };
}

function normalizeRichText(arr) {
  return (arr || []).map(rt => ({
    text: rt.plain_text || '',
    bold: !!rt.annotations?.bold,
    italic: !!rt.annotations?.italic,
    strikethrough: !!rt.annotations?.strikethrough,
    underline: !!rt.annotations?.underline,
    code: !!rt.annotations?.code,
    color: rt.annotations?.color || 'default',
    href: rt.href || null,
  }));
}

function normalizeBlock(block) {
  const type = block.type;
  const data = block[type] || {};
  switch (type) {
    case 'paragraph':
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'bulleted_list_item':
    case 'numbered_list_item':
    case 'quote':
      return { type, text: normalizeRichText(data.rich_text) };
    case 'to_do':
      return { type, text: normalizeRichText(data.rich_text), checked: !!data.checked };
    case 'callout':
      return { type, text: normalizeRichText(data.rich_text), icon: data.icon?.emoji || null };
    case 'divider':
      return { type };
    case 'image': {
      const url = data.type === 'external' ? data.external?.url : data.file?.url;
      return { type, url, caption: normalizeRichText(data.caption) };
    }
    default:
      return { type: 'unsupported', blockType: type };
  }
}

// Fetches the live body content of a Notion page (paragraphs, headings,
// lists, images, etc.) — not cached, since image URLs are time-limited and
// content can change independently of the tracked properties.
async function fetchPageContent(pageId) {
  const blocks = [];
  let cursor;
  do {
    const res = await withRetry(() => getClient().blocks.children.list({ block_id: pageId, start_cursor: cursor, page_size: 100 }));
    blocks.push(...res.results.map(normalizeBlock));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

// Comments require the integration to have comment-read capability enabled;
// fails gracefully (empty list) rather than breaking the whole content fetch.
async function fetchPageComments(pageId) {
  try {
    const comments = [];
    let cursor;
    do {
      const res = await withRetry(() => getClient().comments.list({ block_id: pageId, start_cursor: cursor, page_size: 100 }));
      comments.push(...res.results.map(c => ({
        id: c.id,
        text: normalizeRichText(c.rich_text),
        authorName: c.created_by?.name || null,
        createdTime: c.created_time,
      })));
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
    return comments;
  } catch (err) {
    console.error('[Notion] Failed to fetch comments:', err.message);
    return [];
  }
}

module.exports = {
  normalizeId,
  getKnownDatabaseIds,
  isKnownDatabase,
  resolvePropertyNames,
  getAssigneeOptions,
  fetchTaskFields,
  fetchAllTaskFieldsInDatabase,
  updateNotionPage,
  fetchPageContent,
  fetchPageComments,
};
