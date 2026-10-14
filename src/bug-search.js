// bug-search.js
// Behind /bugs search in Discord: lets testers check whether a bug is
// already reported before they open a ticket. Reports are private tickets,
// so this is the only view other testers get of them, and it is anonymous:
// no reporter, no co-finder, no clips or images, no links, no ticket.

// What a tester can find: anything still being worked on, from just-filed to in QA.
const SEARCHABLE = ['queued', 'open', 'in_progress', 'reviewing', 'on_hold'];
const STATUS_LABEL = { queued: 'Waiting for review', open: 'Accepted', in_progress: 'In progress', reviewing: 'In QA', on_hold: 'On hold for QA' };
const MAX_RESULTS = 10;
const STOP = new Set(['the', 'and', 'for', 'with', 'when', 'that', 'this', 'from', 'into', 'not', 'are', 'was', 'its', 'you', 'can', 'get', 'bug', 'bugs', 'issue', 'game', 'doesnt', 'does', 'have', 'has']);

// Words worth searching on: three letters or more, not filler.
function words(text) {
  return [...new Set(String(text || '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !STOP.has(w)))].slice(0, 8);
}

// The report text with anything that could identify someone or show media taken out.
// names: the reporter's and any co-finder's, taken out wherever they appear in the text.
function scrub(text, max, names = []) {
  let clean = String(text || '');
  for (const name of names) {
    const n = String(name || '').split('#')[0].trim();
    if (n.length >= 3) clean = clean.replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '');
  }
  clean = clean
    .replace(/https?:\/\/\S+/gi, '')                 // clips, images, any link
    .replace(/<(@[!&]?|#)\d+>/g, '')                 // Discord mentions of people, roles, channels
    .replace(/@\S*/g, '')                            // @names and emails
    .replace(/\b\d{6,}\b/g, '')                      // user ids, Roblox ids
    .replace(/[*_`~>|]/g, '')                        // markdown, so a summary cannot ping or format
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

const kindOf = r => {
  const tags = (r.tags || []).map(t => String(t).toLowerCase());
  if (r.ticketKind === 'live' || tags.includes('live-game')) return 'live';
  if (r.ticketKind === 'test' || tags.includes('test-game')) return 'test';
  return null;
};

// query: the tester's words. where: 'test' | 'live' | anything else for both.
async function search(prisma, { query, where } = {}) {
  const terms = words(query);
  if (!terms.length) return { terms, results: [], total: 0 };
  const hit = terms.map((_, i) => `(CASE WHEN lower(r.title) LIKE '%' || $${i + 2} || '%' THEN 2 ELSE 0 END
    + CASE WHEN lower(r.description) LIKE '%' || $${i + 2} || '%' THEN 1 ELSE 0 END)`).join(' + ');
  const matched = terms.map((_, i) => `(CASE WHEN lower(r.title) LIKE '%' || $${i + 2} || '%' OR lower(r.description) LIKE '%' || $${i + 2} || '%' THEN 1 ELSE 0 END)`).join(' + ');
  await require('./report-tickets').ensureTables(prisma); // tells test-game and live-game tickets apart
  const rows = await prisma.$queryRawUnsafe(`
    SELECT * FROM (
      SELECT r.id, r.title, r.description, r.status::text AS status, r."discordUser",
        to_jsonb(r)->>'creditedDiscordUser' AS "creditedDiscordUser", r."bugLevel"::text AS "bugLevel", r.tags, r."createdAt",
        (SELECT t.kind FROM "ReportTicket" t WHERE t."reportId" = r.id) AS "ticketKind",
        ${hit} AS score, ${matched} AS matched
      FROM "Report" r
      WHERE r.type::text IN ('bug', 'crash') AND r.status::text = ANY($1::text[]) AND COALESCE(r.archived, false) = false
    ) x
    WHERE x.matched > 0
    ORDER BY x.matched DESC, x.score DESC, x."createdAt" DESC
    LIMIT 60`, SEARCHABLE, ...terms);
  // Most of the words, not just one of them, unless that is all there is.
  const best = rows.length ? Math.max(...rows.map(r => Number(r.matched))) : 0;
  const floor = terms.length >= 3 ? Math.max(1, Math.min(best, Math.ceil(terms.length / 2))) : 1;
  const wanted = ['test', 'live'].includes(where) ? where : null;
  const kept = rows.filter(r => Number(r.matched) >= floor && (!wanted || kindOf(r) === wanted || kindOf(r) === null));
  return {
    terms,
    total: kept.length,
    results: kept.slice(0, MAX_RESULTS).map(r => ({
      title: scrub(r.title, 100, [r.discordUser, r.creditedDiscordUser]) || 'Untitled report',
      summary: scrub(r.description, 160, [r.discordUser, r.creditedDiscordUser]),
      status: STATUS_LABEL[r.status] || r.status,
      severity: r.bugLevel || null,
      where: kindOf(r),
      reportedAt: r.createdAt,
    })),
  };
}

module.exports = { search, words, scrub, SEARCHABLE, STATUS_LABEL, MAX_RESULTS };
