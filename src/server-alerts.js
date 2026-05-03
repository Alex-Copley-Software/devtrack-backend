const { alert } = require('./discord-notifier');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://lambent-lily-7bf643.netlify.app';

function ageFromDate(date) {
  if (!date) return null;
  const ms = Date.now() - new Date(date).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

async function getQueueMetrics(prisma) {
  const [row] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count, MIN("createdAt") AS oldest
    FROM "Report"
    WHERE queued = true
      AND type IN ('bug', 'crash')
  `;
  return {
    count: row?.count || 0,
    oldestAge: ageFromDate(row?.oldest),
  };
}

async function getQaMetrics(prisma) {
  const [row] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count, MIN("updatedAt") AS oldest
    FROM "Report"
    WHERE status = 'reviewing'
  `;
  return {
    count: row?.count || 0,
    oldestAge: ageFromDate(row?.oldest),
  };
}

async function maybeAlertQueueBacklog(prisma) {
  const metrics = await getQueueMetrics(prisma);
  if (metrics.count > 0 && metrics.count % 3 === 0) {
    await alert({
      kind: 'queue_backlog',
      count: metrics.count,
      oldestAge: metrics.oldestAge,
      url: DASHBOARD_URL,
    });
  }
}

async function alertQaReview(prisma) {
  const metrics = await getQaMetrics(prisma);
  await alert({
    kind: 'qa_review',
    count: metrics.count,
    oldestAge: metrics.oldestAge,
    url: DASHBOARD_URL,
  });
}

module.exports = { maybeAlertQueueBacklog, alertQaReview };
