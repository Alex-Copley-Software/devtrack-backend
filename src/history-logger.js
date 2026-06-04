// history-logger.js
// Logs actions to the ReportHistory table

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ACTION_LABELS = {
  queued: 'Report received from Discord',
  accepted: 'Report accepted',
  declined: 'Report declined and removed',
  in_progress: 'Status changed to In Progress',
  reviewing: 'Sent to QA Review',
  on_hold: 'On Hold for QA',
  resolved: 'Marked as Resolved',
  published: 'Marked as Published',
  assigned: 'Assigned to engineer',
  buglevel: 'Bug level set',
  devnotes: 'Dev notes updated',
  flagged: 'Flagged as ready to publish',
  unflagged: 'Unflagged',
};

async function log({ reportId, action, detail, actorName, actorId }) {
  if (!reportId) return;
  try {
    await prisma.reportHistory.create({
      data: {
        reportId,
        action: ACTION_LABELS[action] || action,
        detail: detail || null,
        actorName: actorName || 'System',
        actorId: actorId || '',
      }
    });
  } catch (err) {
    // Non-fatal, do not break the request if history logging fails.
    console.error('[History] Failed to log:', err.message);
  }
}

module.exports = { log };
