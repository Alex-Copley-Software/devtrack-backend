// tester-qa.js
// Glue between report status changes, the tester QA checks in tester-pay.js
// and the Discord bot. Kept out of the route files so every place that
// changes a report's status makes the same one call.

const pay = require('./tester-pay');
const notifier = require('./discord-notifier');
const { log } = require('./history-logger');
const { broadcast } = require('./events');
const tickets = require('./report-tickets');

// The newest check on a report, as a column for the report queries.
const TESTER_CHECK_COLUMN = `(
  SELECT jsonb_build_object('id', c.id, 'status', c.status, 'note', c.note, 'videoUrl', c."videoUrl",
    'requestedAt', c."requestedAt", 'respondedAt', c."respondedAt", 'resolvedByName', c."resolvedByName", 'discordUser', c."discordUser")
  FROM "ReportQaCheck" c WHERE c."reportId" = r.id ORDER BY c."requestedAt" DESC LIMIT 1
) AS "testerCheck"`;

async function fetchReport(prisma, id) {
  await pay.ensureTables(prisma);
  await tickets.ensureTables(prisma);
  const rows = await prisma.$queryRawUnsafe(`
    SELECT r.*, ${TESTER_CHECK_COLUMN}, ${tickets.TICKET_COLUMN},
      COALESCE(json_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email)) FILTER (WHERE u.id IS NOT NULL), '[]') AS assignees,
      COALESCE(json_agg(DISTINCT jsonb_build_object('id', a.id, 'type', a.type, 'url', a.url, 'filename', a.filename)) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
    FROM "Report" r
    LEFT JOIN "_AssignedReports" ar ON ar."A" = r.id
    LEFT JOIN "User" u ON u.id = ar."B"
    LEFT JOIN "Attachment" a ON a."reportId" = r.id
    WHERE r.id = $1
    GROUP BY r.id`, id);
  return rows[0] || null;
}

// A report "failed QA" when it goes from QA Review straight back to In
// Progress, whoever sent it (staff, or the tester pressing Not fixed). The
// mark stays while it is In Progress and is dropped the moment it moves on.
// Returns true when the mark changed.
async function markQaFail(prisma, reportId, previousStatus, status, actorName) {
  await pay.ensureTables(prisma);
  if (previousStatus === 'reviewing' && status === 'in_progress') {
    await prisma.$executeRawUnsafe(`UPDATE "Report" SET "qaFailedAt" = CURRENT_TIMESTAMP, "qaFailedBy" = $2 WHERE id = $1`, reportId, actorName || null);
    return true;
  }
  return (await prisma.$executeRawUnsafe(
    `UPDATE "Report" SET "qaFailedAt" = NULL, "qaFailedBy" = NULL WHERE id = $1 AND "qaFailedAt" IS NOT NULL`, reportId)) > 0;
}

// Call after a report's status has been changed. Never throws: a Discord or
// bookkeeping problem here must not fail the status change itself.
async function afterStatusChange(prisma, report, previousStatus, actorName) {
  try {
    if (!report || report.status === previousStatus) return null;
    const marked = await markQaFail(prisma, report.id, previousStatus, report.status, actorName);
    if (marked && report.status === 'in_progress') {
      await log({ reportId: report.id, action: 'qa_failed', detail: null, actorName: actorName || 'System', actorId: '' });
    }
    const result = await pay.onStatusChange(prisma, report, previousStatus, actorName);
    // Truthy either way, so the caller re-reads the report and sends the mark to the dashboard.
    if (!result) return marked ? { kind: 'qa_mark' } : null;
    if (result.kind === 'ask') {
      await log({ reportId: report.id, action: 'tester_qa_requested', detail: report.discordUser || null, actorName: actorName || 'System', actorId: '' });
      notifier.qaCheck({
        checkId: result.check.id, threadId: result.check.threadId, discordUserId: result.check.discordUserId,
        title: report.title, requireVideo: result.requireVideo,
      });
    } else {
      notifier.qaCheckUpdate({
        threadId: result.check.threadId, messageId: result.check.messageId, discordUserId: result.check.discordUserId,
        state: result.state, actorName: result.actor,
      });
    }
    return result;
  } catch (err) {
    console.error('[TesterQA] afterStatusChange failed:', err.message);
    return null;
  }
}

// The tester pressed Fixed or Not fixed in Discord.
async function applyAnswer(prisma, checkId, { discordUserId, discordUserName, verdict, note, videoUrl }) {
  const { check, settings } = await pay.respond(prisma, checkId, { discordUserId, verdict, note, videoUrl });
  const actorName = `${discordUserName || check.discordUser || 'Tester'} (tester)`;
  let autoResolved = false;

  if (verdict === 'fixed') {
    await log({ reportId: check.reportId, action: 'tester_fixed', detail: check.videoUrl || null, actorName, actorId: '' });
    if (settings.autoResolve) {
      // Only if it is still waiting in QA Review; staff may have moved it meanwhile.
      const moved = await prisma.$executeRawUnsafe(`
        UPDATE "Report" SET status = 'resolved'::"Status", "publishStatus" = 'published', "updatedAt" = NOW()
        WHERE id = $1 AND status::text = 'reviewing'`, check.reportId);
      if (moved) {
        autoResolved = true;
        await log({ reportId: check.reportId, action: 'resolved', detail: 'Resolved by the tester confirming the fix', actorName, actorId: '' });
      }
    }
  } else {
    const sentBack = await prisma.$executeRawUnsafe(`
      UPDATE "Report" SET status = 'in_progress'::"Status", "updatedAt" = NOW()
      WHERE id = $1 AND status::text = 'reviewing'`, check.reportId);
    if (sentBack) await markQaFail(prisma, check.reportId, 'reviewing', 'in_progress', actorName);
    await log({ reportId: check.reportId, action: 'tester_not_fixed', detail: check.note || null, actorName, actorId: '' });
  }

  const report = await fetchReport(prisma, check.reportId);
  if (report) {
    broadcast('report.updated', { report, actor: null, timestamp: new Date().toISOString() });
    broadcast('activity.changed', { reportId: report.id, timestamp: new Date().toISOString() });
    if (autoResolved) {
      notifier.notify({
        threadId: report.discordThreadId, reportType: report.type, action: 'resolved', bugLevel: report.bugLevel,
        devNotes: report.devNotes, discordUserId: report.discordUserId, notifyOwner: false,
      });
    }
  }
  return { check, autoResolved, reportTitle: report?.title || null };
}

module.exports = { TESTER_CHECK_COLUMN, fetchReport, afterStatusChange, applyAnswer, markQaFail };
