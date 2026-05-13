const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { hasRole } = require('../middleware/roles');

const prisma = new PrismaClient();
const PAGE_KEYS = ['bugs', 'suggestions', 'imports', 'expenses', 'admin'];

async function ensureUserAccessColumn() {
  await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pageAccess" TEXT[]`);
  await prisma.$executeRawUnsafe(`
    UPDATE "User"
    SET "pageAccess" = array_append(COALESCE("pageAccess", ARRAY[]::text[]), 'imports')
    WHERE role IN ('owner', 'admin', 'engineer')
      AND NOT ('imports' = ANY(COALESCE("pageAccess", ARRAY[]::text[])))
  `);
}

// GET /api/users - list all engineers
router.get('/', auth, async (req, res) => {
  try {
    await ensureUserAccessColumn();
    const includeRoleAccounts = req.query.includeRoleAccounts === 'true' && hasRole(req.user, ['admin']);
    const roleFilter = includeRoleAccounts ? '' : `WHERE u.role NOT IN ('admin', 'owner')`;

    // Use raw SQL for assignedReports.status so Prisma's stale Status enum
    // client never tries to deserialize newer values like "declined".
    const users = await prisma.$queryRawUnsafe(`
      WITH resolved_counts AS (
        SELECT
          ar."B" AS "actorId",
          COUNT(DISTINCT r.id)::int AS resolved
        FROM "_AssignedReports" ar
        JOIN "Report" r ON r.id = ar."A"
        WHERE r.status = 'resolved'
          AND r.type IN ('bug', 'crash')
        GROUP BY ar."B"
      ),
      accepted_counts AS (
        SELECT
          rh."actorId",
          COUNT(DISTINCT rh."reportId")::int AS accepted
        FROM "ReportHistory" rh
        JOIN "Report" r ON r.id = rh."reportId"
        WHERE rh.action LIKE '%Report accepted%'
          AND r.type IN ('bug', 'crash')
        GROUP BY rh."actorId"
      ),
      qa_approved_counts AS (
        SELECT
          rh."actorId",
          COUNT(DISTINCT rh."reportId")::int AS approved
        FROM "ReportHistory" rh
        JOIN "Report" r ON r.id = rh."reportId"
        WHERE rh.action LIKE '%Marked as Resolved%'
          AND r.type IN ('bug', 'crash')
        GROUP BY rh."actorId"
      )
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        CASE
          WHEN u.role = 'owner' THEN ARRAY['bugs','suggestions','imports','expenses','admin']::text[]
          ELSE COALESCE(u."pageAccess", CASE
          WHEN u.role = 'admin' THEN ARRAY['bugs','suggestions','imports','expenses','admin']::text[]
          WHEN u.role = 'engineer' THEN ARRAY['bugs','suggestions','imports']::text[]
          WHEN u.role IN ('qa', 'reviewer') THEN ARRAY['bugs']::text[]
          ELSE ARRAY['bugs']::text[]
        END)
        END AS "pageAccess",
        CASE WHEN u.role = 'engineer' THEN COALESCE(rc.resolved, 0) ELSE 0 END AS "resolvedReports",
        CASE WHEN u.role = 'qa' THEN COALESCE(ac.accepted, 0) ELSE 0 END AS "acceptedReports",
        CASE WHEN u.role IN ('qa', 'reviewer') THEN COALESCE(qac.approved, 0) ELSE 0 END AS "qaApprovedReports",
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', t.id, 'done', t.done))
          FILTER (WHERE t.id IS NOT NULL), '[]'
        ) AS tasks,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', r.id, 'status', r.status::text))
          FILTER (WHERE r.id IS NOT NULL), '[]'
        ) AS "assignedReports"
      FROM "User" u
      LEFT JOIN "Task" t ON t."userId" = u.id
      LEFT JOIN "_AssignedReports" ar ON ar."B" = u.id
      LEFT JOIN "Report" r ON r.id = ar."A"
      LEFT JOIN resolved_counts rc ON rc."actorId" = u.id
      LEFT JOIN accepted_counts ac ON ac."actorId" = u.id
      LEFT JOIN qa_approved_counts qac ON qac."actorId" = u.id
      ${roleFilter}
      GROUP BY u.id, rc.resolved, ac.accepted, qac.approved
      ORDER BY u."createdAt" ASC
    `);
    res.json(users);
  } catch (err) {
    console.error('[GET users]', err.message);
    res.status(500).json({ error: 'Could not fetch users' });
  }
});

module.exports = router;
