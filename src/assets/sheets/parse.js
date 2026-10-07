// Pure parsing of the "AE_Update_Asset_Tracker" sheet into plain records,
// plus the dry-run report. No network, no database: tested with a fixture.
//
// Columns are matched by header text, not position, and the header row is
// found by scanning the first few rows (the brief says row 4 for most tabs
// and row 1 for Lists / Dev Lists; scanning handles both and survives a
// row being added above). Computed columns are simply never read.

const C = require('../constants');

const norm = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9#]+/g, '');
const text = v => (v === null || v === undefined ? '' : String(v).trim());

// field -> accepted header spellings (normalized)
const COLUMNS = {
  updates: {
    number: ['update#', 'update', '#'],
    name: ['updatename', 'name'],
    status: ['status'],
    targetRelease: ['targetrelease', 'targetreleasedate', 'release'],
    lead: ['lead'],
    notes: ['summarynotes', 'summary', 'notes'],
  },
  items: {
    itemNumber: ['#', 'item#'],
    updateNumber: ['update#'],
    contentType: ['contenttype', 'type'],
    displayName: ['displayname'],
    internalName: ['internalnameid', 'internalname'],
    owner: ['owner'],
    priority: ['priority'],
    notes: ['descriptionnotes', 'description', 'notes'],
  },
  templates: {
    contentType: ['contenttype'],
    taskNumber: ['task#', '#'],
    discipline: ['discipline'],
    deliverable: ['deliverable'],
    definitionOfDone: ['definitionofdone'],
    required: ['required'],
    taskCode: ['taskid'],
  },
  tasks: {
    updateNumber: ['update#'],
    internalName: ['internalname', 'internalnameid'],
    assignee: ['assignedto', 'assignee'],
    status: ['status'],
    dueDate: ['duedate', 'due'],
    notes: ['notesassetid', 'notes'],
    itemNumber: ['item#'],
    taskCode: ['taskid'],
  },
  devs: {
    name: ['name', 'devname'],
    discipline: ['discipline', 'primarydiscipline'],
    secondaryDiscipline: ['secondarydiscipline'],
    status: ['status'],
    discordProfileUrl: ['discordprofilelink', 'discordprofile', 'discord'],
    notes: ['devnotes', 'notes'],
  },
};

// Headers that must be present for a row to be accepted as the header row.
const KEY_HEADERS = {
  updates: ['number', 'name'],
  items: ['updateNumber', 'internalName'],
  templates: ['contentType', 'taskCode'],
  tasks: ['taskCode', 'status'],
  devs: ['name', 'discipline'],
};

function mapHeader(row, spec) {
  const cells = row.map(norm);
  const map = {};
  for (const [field, names] of Object.entries(spec)) {
    for (const name of names) {
      const idx = cells.indexOf(name);
      if (idx !== -1) { map[field] = idx; break; }
    }
  }
  return map;
}

// Returns { headerIndex, map } or null if no row in the first 10 looks like the header.
function findHeader(rows, kind) {
  const spec = COLUMNS[kind];
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const map = mapHeader(rows[i] || [], spec);
    if (KEY_HEADERS[kind].every(k => map[k] !== undefined)) return { headerIndex: i, map };
  }
  return null;
}

function readTable(rows, kind, tabName, problems) {
  if (!rows || !rows.length) {
    problems.push({ tab: tabName, row: null, issue: 'Tab is missing or empty' });
    return [];
  }
  const header = findHeader(rows, kind);
  if (!header) {
    problems.push({ tab: tabName, row: null, issue: `Could not find the header row (looked for: ${KEY_HEADERS[kind].map(k => COLUMNS[kind][k][0]).join(', ')})` });
    return [];
  }
  const out = [];
  for (let i = header.headerIndex + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (!row.some(cell => text(cell) !== '')) continue;
    const record = { _row: i + 1 };
    for (const [field, idx] of Object.entries(header.map)) record[field] = row[idx] === undefined ? '' : row[idx];
    out.push(record);
  }
  return out;
}

// Sheets returns dates as serial numbers (days since 1899-12-30) when asked
// for unformatted values; hand-typed cells may still be strings.
function parseSheetDate(value) {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = text(value);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

function parseBool(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  const s = norm(value);
  if (['yes', 'y', 'true', '1', 'required'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'optional'].includes(s)) return false;
  return fallback;
}

function parseInteger(value) {
  const n = Number(text(value).replace(/^#/, ''));
  return Number.isInteger(n) ? n : null;
}

// Update numbers can be decimal (3.5 is a mid-cycle update).
function parseUpdateNumber(value) {
  const s = text(value).replace(/^#/, '');
  const n = Number(s);
  return s !== '' && Number.isFinite(n) && n >= 0 ? n : null;
}

// Match a cell to an enum value, ignoring case and spacing.
function matchEnum(value, allowed) {
  const key = norm(value);
  if (!key) return null;
  return allowed.find(a => norm(a) === key) ?? undefined;
}

// Lists tab: each column is one list, header in the first row.
function parseLists(rows) {
  const lists = {};
  if (!rows || !rows.length) return lists;
  const wanted = {
    contentTypes: ['contenttypes', 'contenttype'],
    disciplines: ['disciplines', 'discipline'],
  };
  rows[0].forEach((cell, col) => {
    const header = norm(cell);
    for (const [key, names] of Object.entries(wanted)) {
      if (!names.includes(header)) continue;
      lists[key] = rows.slice(1).map(r => text(r?.[col])).filter(Boolean);
    }
  });
  return lists;
}

// Dev Lists tab: header row is discipline names, cells below are dev names.
// The sheet keeps helper columns to the right ("Design #", counters); only
// columns headed by a known discipline are read.
function parseDevLists(rows, disciplines) {
  const out = [];
  if (!rows || !rows.length) return out;
  rows[0].forEach((cell, col) => {
    const discipline = matchEnum(cell, disciplines);
    if (!discipline) return;
    for (const row of rows.slice(1)) {
      const name = text(row?.[col]);
      if (name) out.push({ discipline, name });
    }
  });
  return out;
}

// tabs: { updates, items, templates, tasks, devs, lists, devLists } as
// arrays of rows. Returns normalized records, counts and everything that
// could not be mapped. Nothing here touches the database.
function buildImportPlan(tabs) {
  const problems = [];
  const add = (tab, row, issue) => problems.push({ tab, row, issue });

  const lists = parseLists(tabs.lists);
  const disciplines = [...new Set([...(lists.disciplines || []), ...C.DEFAULT_DISCIPLINES])];
  const findDiscipline = v => matchEnum(v, disciplines);

  // ── devs ──
  const devs = [];
  const devByName = new Map();
  for (const r of readTable(tabs.devs, 'devs', 'Devs', problems)) {
    const name = text(r.name);
    if (!name) continue;
    if (devByName.has(norm(name))) { add('Devs', r._row, `Duplicate dev "${name}"`); continue; }
    const status = matchEnum(r.status, C.DEV_STATUSES);
    if (status === undefined) add('Devs', r._row, `Unknown dev status "${text(r.status)}" for ${name}, using Active`);
    const dev = {
      name,
      discipline: findDiscipline(r.discipline) || null,
      secondaryDiscipline: findDiscipline(r.secondaryDiscipline) || null,
      status: status || 'Active',
      discordProfileUrl: text(r.discordProfileUrl) || null,
      notes: text(r.notes) || null,
      disciplines: [],
    };
    if (text(r.discipline) && !dev.discipline) add('Devs', r._row, `Unknown discipline "${text(r.discipline)}" for ${name}`);
    if (text(r.secondaryDiscipline) && !dev.secondaryDiscipline) add('Devs', r._row, `Unknown secondary discipline "${text(r.secondaryDiscipline)}" for ${name}`);
    if (dev.discordProfileUrl && !/\d{17,20}/.test(dev.discordProfileUrl)) add('Devs', r._row, `No Discord user id in profile link for ${name}`);
    devs.push(dev);
    devByName.set(norm(name), dev);
  }
  for (const { discipline: d, name } of parseDevLists(tabs.devLists, disciplines)) {
    const dev = devByName.get(norm(name));
    if (!dev) continue; // the tab is built from Devs by formulas; anything else in it is a counter or a note
    if (!dev.disciplines.includes(d)) dev.disciplines.push(d);
  }
  const findDev = v => devByName.get(norm(v))?.name;

  // ── templates and content types ──
  const templates = [];
  const typeNames = [...(lists.contentTypes || [])];
  const seenCodes = new Set();
  for (const r of readTable(tabs.templates, 'templates', 'Templates', problems)) {
    const taskCode = text(r.taskCode).toUpperCase();
    const contentType = text(r.contentType);
    if (!taskCode || !contentType) { add('Templates', r._row, 'Missing Task ID or Content Type'); continue; }
    if (seenCodes.has(taskCode)) { add('Templates', r._row, `Duplicate Task ID ${taskCode}`); continue; }
    const discipline = findDiscipline(r.discipline);
    if (!discipline) { add('Templates', r._row, `Unknown discipline "${text(r.discipline)}" on ${taskCode}`); continue; }
    if (!text(r.deliverable)) { add('Templates', r._row, `No deliverable on ${taskCode}`); continue; }
    seenCodes.add(taskCode);
    if (!matchEnum(contentType, typeNames)) typeNames.push(contentType);
    templates.push({
      taskCode,
      contentType: matchEnum(contentType, typeNames),
      taskNumber: parseInteger(r.taskNumber) ?? templates.length + 1,
      discipline,
      deliverable: text(r.deliverable),
      definitionOfDone: text(r.definitionOfDone) || null,
      required: parseBool(r.required, true),
    });
  }
  const contentTypes = typeNames.length ? typeNames : [...C.DEFAULT_CONTENT_TYPES];
  const templateByCode = new Map(templates.map(t => [t.taskCode, t]));

  // ── updates ──
  const updates = [];
  const updateNumbers = new Set();
  for (const r of readTable(tabs.updates, 'updates', 'Updates', problems)) {
    const number = parseUpdateNumber(r.number);
    const name = text(r.name);
    // A pre-numbered row nobody has filled in yet.
    if (!name && !text(r.status) && !text(r.lead) && !text(r.notes)) continue;
    if (number === null || !name) { add('Updates', r._row, 'Missing Update # or Update Name'); continue; }
    if (updateNumbers.has(number)) { add('Updates', r._row, `Duplicate Update #${number}`); continue; }
    const status = matchEnum(r.status, C.UPDATE_STATUSES);
    if (status === undefined) add('Updates', r._row, `Unknown update status "${text(r.status)}" on #${number}, using Planning`);
    const targetRelease = parseSheetDate(r.targetRelease);
    if (targetRelease === undefined) add('Updates', r._row, `Unreadable target release "${text(r.targetRelease)}" on #${number}`);
    const lead = text(r.lead);
    if (lead && !findDev(lead)) add('Updates', r._row, `Lead "${lead}" is not on the Devs tab (kept as plain text)`);
    updateNumbers.add(number);
    updates.push({
      number, name, status: status || 'Planning', targetRelease: targetRelease || null,
      leadDev: findDev(lead) || null, leadName: lead || null, notes: text(r.notes) || null,
    });
  }

  // ── content items ──
  const items = [];
  const itemByNumber = new Map();
  const itemByKey = new Map();
  for (const r of readTable(tabs.items, 'items', 'Update Content', problems)) {
    const updateNumber = parseUpdateNumber(r.updateNumber);
    const internalName = text(r.internalName) || text(r.displayName);
    if (!text(r.updateNumber) && !internalName && !text(r.contentType)) continue; // pre-numbered blank row
    if (updateNumber === null || !internalName) { add('Update Content', r._row, 'Missing Update # or Internal Name'); continue; }
    if (!updateNumbers.has(updateNumber)) { add('Update Content', r._row, `Update #${updateNumber} is not on the Updates tab (${internalName})`); continue; }
    const contentType = matchEnum(r.contentType, contentTypes);
    if (!contentType) { add('Update Content', r._row, `Unknown content type "${text(r.contentType)}" (${internalName})`); continue; }
    const key = `${updateNumber}:${norm(internalName)}`;
    if (itemByKey.has(key)) { add('Update Content', r._row, `Duplicate "${internalName}" in update #${updateNumber}`); continue; }
    const priority = matchEnum(r.priority, C.PRIORITIES);
    if (priority === undefined) add('Update Content', r._row, `Unknown priority "${text(r.priority)}" (${internalName}), using Medium`);
    const owner = text(r.owner);
    if (owner && !findDev(owner)) add('Update Content', r._row, `Owner "${owner}" is not on the Devs tab (kept as plain text)`);
    const item = {
      itemNumber: parseInteger(r.itemNumber), updateNumber, contentType,
      displayName: text(r.displayName) || null, internalName,
      ownerDev: findDev(owner) || null, ownerName: owner || null,
      priority: priority || 'Medium', notes: text(r.notes) || null,
    };
    items.push(item);
    itemByKey.set(key, item);
    if (item.itemNumber !== null) itemByNumber.set(item.itemNumber, item);
  }

  // ── tasks (manual fields only) ──
  const tasks = [];
  const seenTasks = new Set();
  for (const r of readTable(tabs.tasks, 'tasks', 'Task Tracker', problems)) {
    const taskCode = text(r.taskCode).toUpperCase();
    if (!taskCode) continue;
    const itemNumber = parseInteger(r.itemNumber);
    const updateNumber = parseUpdateNumber(r.updateNumber);
    const item = (itemNumber !== null && itemByNumber.get(itemNumber))
      || itemByKey.get(`${updateNumber}:${norm(r.internalName)}`);
    const where = `${taskCode} / item ${itemNumber ?? text(r.internalName)}`;
    if (!item) { add('Task Tracker', r._row, `No matching content item for ${where}`); continue; }
    const template = templateByCode.get(taskCode);
    if (!template) { add('Task Tracker', r._row, `Task ID ${taskCode} is not on the Templates tab`); continue; }
    if (template.contentType !== item.contentType) {
      add('Task Tracker', r._row, `${taskCode} is a ${template.contentType} task but ${item.internalName} is a ${item.contentType}`);
      continue;
    }
    const key = `${item.updateNumber}:${norm(item.internalName)}:${taskCode}`;
    if (seenTasks.has(key)) { add('Task Tracker', r._row, `Duplicate row for ${where}`); continue; }
    seenTasks.add(key);

    const task = { updateNumber: item.updateNumber, internalName: item.internalName, taskCode };
    const status = matchEnum(r.status, C.TASK_STATUSES);
    if (status === undefined) add('Task Tracker', r._row, `Status "${text(r.status)}" is outside the list (${where}), left as Not Started`);
    else if (status) task.status = status;
    const assignee = text(r.assignee);
    if (assignee) {
      if (findDev(assignee)) task.assignee = findDev(assignee);
      else add('Task Tracker', r._row, `Unknown dev "${assignee}" (${where}), left unassigned`);
    }
    const dueDate = parseSheetDate(r.dueDate);
    if (dueDate === undefined) add('Task Tracker', r._row, `Unreadable due date "${text(r.dueDate)}" (${where})`);
    else if (dueDate) task.dueDate = dueDate;
    if (text(r.notes)) task.notes = text(r.notes);
    tasks.push(task);
  }

  return {
    disciplines, contentTypes, devs, templates, updates, items, tasks, problems,
    counts: {
      disciplines: disciplines.length, contentTypes: contentTypes.length, devs: devs.length,
      templates: templates.length, updates: updates.length, items: items.length,
      taskRows: tasks.length,
      tasksWithManualData: tasks.filter(t => t.status || t.assignee || t.dueDate || t.notes).length,
      problems: problems.length,
    },
  };
}

function formatReport(plan) {
  const lines = ['Asset sheet import', ''];
  for (const [k, v] of Object.entries(plan.counts)) lines.push(`  ${k.padEnd(22)} ${v}`);
  if (plan.problems.length) {
    lines.push('', `Could not map ${plan.problems.length} row(s):`);
    for (const p of plan.problems) lines.push(`  [${p.tab}${p.row ? ` row ${p.row}` : ''}] ${p.issue}`);
  } else {
    lines.push('', 'Every row mapped cleanly.');
  }
  return lines.join('\n');
}

module.exports = { buildImportPlan, formatReport, parseSheetDate, parseBool, matchEnum, findHeader, norm };
