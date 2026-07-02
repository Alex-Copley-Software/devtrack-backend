// notion-client.js
// Notion API wrapper: page fetch/update, database schema caching, and
// per-database property-name mapping (title/status/assignee/priority/dueDate).

const { Client } = require('@notionhq/client');

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.NOTION_API_KEY) throw new Error('NOTION_API_KEY is not set');
    client = new Client({ auth: process.env.NOTION_API_KEY });
  }
  return client;
}

function normalizeId(id) {
  return String(id || '').replace(/-/g, '');
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
  const schema = await getClient().databases.retrieve({ database_id: databaseId });
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

// Fetches the full page (webhook payloads are sparse) and normalizes it into
// the fields we care about for the NotionTask table. Returns the resolved
// databaseId too, since webhook payloads don't reliably include it.
async function fetchTaskFields(pageId) {
  const page = await getClient().pages.retrieve({ page_id: pageId });
  if (page.parent?.type !== 'database_id') {
    return { databaseId: null, page };
  }
  const databaseId = page.parent.database_id;
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

  if (!Object.keys(properties).length) return null;

  const updated = await getClient().pages.update({ page_id: pageId, properties });
  return { notionLastEditedTime: updated.last_edited_time };
}

module.exports = {
  normalizeId,
  getKnownDatabaseIds,
  isKnownDatabase,
  resolvePropertyNames,
  getAssigneeOptions,
  fetchTaskFields,
  updateNotionPage,
};
