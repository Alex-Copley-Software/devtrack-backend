# Assets page + AI Asset Agent: plan

Written after Phase 0 recon, before any code. Deviations from the original
brief are called out in **Deviations** at the bottom.

## What the codebase looks like today

DevTrack is four repos, not one:

| Repo | What it is | Deploys |
|------|-----------|---------|
| `devtrack-backend` | Express API, Postgres on Railway | push to `main` |
| `devtrack-bot` | Discord.js 14 bot | push to `main` |
| `devtrack-dashboard` | Static site on Netlify, no build step | push to `main` |
| `devtrack-mcp` | MCP server for Codex (not touched here) | manual copy |

- **Schema and migrations.** `prisma/schema.prisma` covers the original tables
  (`User`, `Report`, `Attachment`, `Task`, `ReportHistory`, `Message`,
  `Expense`). There are no migration files. Everything added since is a
  raw-SQL table created at runtime with `CREATE TABLE IF NOT EXISTS` behind a
  once-per-process guard (`BoardTask`, `BoardTaskHistory`, `ImportRequest`,
  `CreditRequest`, `ReportPauseState`, `TeamReport`, ...). Tables are
  PascalCase, columns camelCase, both double-quoted. Queries go through
  `prisma.$queryRawUnsafe(sql, ...values)`.
- **Bug queue / suggestions.** The bot turns a forum thread into a `Report`
  (`POST /api/bot/report`, `x-bot-secret` header). Staff accept, assign and
  move it through statuses from the dashboard; each change is written to
  `ReportHistory` and broadcast over SSE. The backend triggers Discord side
  effects by calling the bot's small webhook server.
- **Auth and roles.** JWT (`id, email, name, role`). Roles are `owner`,
  `admin`, `engineer`, `qa`, `reviewer`. `requireRole()` gates by role
  (owner always passes); `requirePageAccess(page)` gates by the per-user
  `pageAccess` checkbox list.
- **Audit history.** One history table per feature (`ReportHistory`,
  `BoardTaskHistory`, import history), each with action, detail, actor.
- **Notion sync.** Gone. The bidirectional Notion task sync was replaced by
  the native `BoardTask` board (`scripts/migrate-notion-tasks-to-board.js`).
  Notion only survives as a `notionUrl` link field.
- **Kanban.** Not a component: HTML5 drag and drop written inline in the
  dashboard (`.kboard/.kcol/.kcard`). The pattern is reusable, the code is not.
- **Frontend.** One 3,100-line `index.html`, vanilla JS, no framework, no
  build. State lives in one object and every change re-renders the whole page
  with `innerHTML`. Design tokens are CSS variables (dark, purple accent,
  Inter + JetBrains Mono). `/expenses/` is already a separate standalone page
  that shares the login token.
- **Live updates.** SSE at `/api/events`, `broadcast(event, payload)`.
- **Bot.** `src/index.js` holds the client, slash-command registration and the
  interaction dispatcher; each command lives in its own file. The bot has no
  database access: everything goes through the API. Message Content intent
  is already enabled. Durable state lives in Postgres and is claimed with an
  atomic `UPDATE ... RETURNING` (see credit-request escalation); the bot polls.
- **Claude.** The backend already calls the Anthropic API for team reports
  and update logs (`@anthropic-ai/sdk`, with a fresh-connection fetch because
  keep-alive sockets go stale on Railway).
- **Tests.** None exist anywhere.

## Schema

Follows the runtime `CREATE TABLE IF NOT EXISTS` pattern in
`src/assets/schema.js`. Nothing is created until `ASSETS_ENABLED=true` and
the first request arrives.

| Table | Purpose | Stable key |
|-------|---------|-----------|
| `AssetDiscipline` | Discipline list (ordered) | `name` |
| `AssetContentType` | Unit, Map / Stage, Boss, ... | `name` |
| `AssetTaskTemplate` | Checklist row for a content type | `taskCode` (T0001) |
| `AssetDev` | Roster; `discordUserId` parsed from profile link; optional `userId` link to a DevTrack login | `name` |
| `AssetDevDiscipline` | Dev to discipline, many to many (drives the assignee picker) | pair |
| `AssetUpdate` | One per update | `number` |
| `AssetContentItem` | One per thing in an update | `updateId + internalName` |
| `AssetTask` | One per template task per item; holds only the manual fields (status, assignee, due date, notes) plus `active` | `contentItemId + templateId`, and a short numeric `ref` |
| `AssetActivity` | Audit log: who, field, before, after, `source` (human / agent / import), link to suggestion and Discord messages | |
| `AssetSavedView` | Per-user saved table views | |
| `AssetSetting` | Key/value settings (agent config) | `key` |
| `AssetAgentChannel` | Channel allowlist | `channelId` |
| `AssetAgentMessage` | Ingested messages, pruned after N days | Discord message id |
| `AssetAgentBatch` | One conversation batch sent to the model | |
| `AssetAgentSuggestion` | Proposed change, before/after, confidence, evidence, status | `dedupeKey` |
| `AssetAgentUsage` | Tokens and cost per model call | |

Rules:

- **No rollups stored.** Progress, counts, blocked and workload are computed
  in SQL. Progress = Done / active tasks that are not `N/A`.
- **Task text lives on the template.** A task row points at its template for
  discipline, deliverable, definition of done and required, so manual fields
  can never be detached from their task by a rebuild.
- **Generation is additive.** Creating an item inserts one task per active
  template of its type. Adding a template inserts the missing task on every
  existing item of that type (`ON CONFLICT DO NOTHING`). Removing a template
  sets `active = false` on it and its tasks; nothing is deleted.

## API

All under `/api/assets`, behind `ASSETS_ENABLED`, JWT auth and a new
`assets` page-access key. Returns 404 when the flag is off.

- `GET /bootstrap`: enums, disciplines, content types, devs, updates with
  rollups, the caller's permissions, saved views.
- `updates`, `items`, `devs`, `content-types`, `templates`: CRUD.
  `POST /templates/preview` returns how many tasks a change would add.
- `GET /tasks`: compact rows for the table. `PATCH /tasks/:id`,
  `POST /tasks/bulk`.
- `GET /updates/:id/overview`: header rollups, per-discipline breakdown,
  needs-attention lists.
- `GET /activity`: feed for an update, item or task.
- `views`: saved views CRUD.
- `suggestions`: list, accept (with optional edits), reject, bulk accept.
- `agent/settings`, `agent/channels`, `agent/usage`: admin only.

Every write goes through one service layer that validates, checks
permissions, writes `AssetActivity`, and broadcasts `assets.changed` on the
existing SSE stream. The agent and the importer call the same layer with a
different `source`.

Bot-facing routes live under `/api/bot/assets` with the existing
`x-bot-secret` auth.

### Roles

The brief names viewers, devs, leads/managers and admins. DevTrack has
`owner / admin / engineer / qa / reviewer`, and most asset devs (artists,
animators) have no DevTrack login at all. Mapping:

| Brief | DevTrack |
|-------|----------|
| Admin (templates, agent settings, everything) | `owner`, `admin` |
| Lead / manager (edit everything else, accept suggestions) | `engineer`; or a login linked to a dev whose discipline is `Manager`; or the lead of that update |
| Dev (status, due date, notes on own tasks) | any login linked to an `AssetDev` via `userId` |
| Viewer (read only) | anyone else with the `assets` page box ticked |

## Page layout

A standalone page at `/assets/` in the dashboard repo (same pattern as
`/expenses/`), vanilla JS split across a few files, sharing the login token
and the design tokens. It keeps its own render loop so the virtualized table
is not torn down by the main dashboard's full-page re-render.

Left rail: update switcher and the views (Overview, Board, Tasks, Kanban,
Team, Suggestions, Templates, Settings). Right: side panel for an item or
task. Global: command palette (Ctrl/Cmd+K), table shortcuts (j/k, s, a, e),
optimistic writes with rollback, SSE-driven refresh, activity feed with agent
changes labeled and linked to Discord.

## Agent flow

```
Discord message in an allowlisted channel
  -> bot POSTs it to /api/bot/assets/messages          (stored, 30-day expiry)
bot polls POST /api/bot/assets/agent/tick every minute
  -> backend atomically claims any channel/thread with 25+ unbatched
     messages or 3+ minutes of quiet
  -> pass 1 (Haiku): is this about content, assets or task progress?
  -> pass 2 (Sonnet, forced tool call): proposed actions
  -> validate against schema and enums, drop unknown ids, dedupe against
     pending suggestions, skip fields a human edited after the evidence
  -> write AssetAgentSuggestion (pending), or auto-apply if enabled
  -> return new suggestions to the bot
bot posts each one to #asset-agent with Accept / Reject buttons
```

Model calls run in the backend (it already has the SDK, the key and the
Railway socket fix); the bot stays a thin Discord adapter. Accepting from
the web or from Discord goes through the same service call as a human edit,
with `source = agent` and the accepting user recorded. Prompts for both
passes live in `src/assets/prompts/*.md`. Usage and cost are logged per call;
a daily budget cap pauses the agent.

## Import

`scripts/import-asset-sheet.js`: reads the sheet through the Sheets REST API
with a service-account JWT signed with Node's `crypto` (no Google SDK),
parses with pure functions (unit-tested against a fixture), and upserts
through the service layer with `source = import`. `--dry-run` prints counts
and unmapped rows and writes nothing. Optional nightly export to a
"DevTrack Export" tab behind `ASSET_SHEET_EXPORT=true`.

## Deviations

1. **Table names.** `AssetUpdate`, `AssetContentItem`, ... instead of
   `updates`, `content_items`, to match the codebase's PascalCase tables and
   avoid colliding with the existing `Task` table.
2. **No migrations.** The codebase has none; tables self-create at runtime.
3. **Notion sync** no longer exists, so there is nothing to integrate with
   beyond rendering Notion links as chips.
4. **Kanban** is rebuilt for this page using the existing drag-and-drop
   pattern and styles; there is no component to reuse.
5. **Standalone `/assets/` page** rather than another branch inside
   `index.html`, for the reason given under Page layout.
6. **Roles** are mapped as in the table above rather than adding new roles.
7. **Task ID.** In the sheet a Task ID (T0001) identifies a template row, and
   a tracker row is Item # + Task ID. That pair stays the import key. Each
   task also gets a short numeric `ref` for Discord (`/assets task:412`).
8. **Durable queue.** The bot's on-disk retry queue does not survive a
   Railway redeploy, so the agent uses the Postgres claim pattern instead.
9. **Feature flags** are needed in two places each: `ASSETS_ENABLED` on the
   backend and bot (slash command), `ASSET_AGENT_ENABLED` on the backend and
   bot (ingest). The dashboard reads the backend's flag from `/api/config`.
10. **Tests** use Node's built-in runner, with PGlite (in-process Postgres)
    as a dev dependency so the real SQL is exercised without a database
    server. Nothing in production depends on it.

Found while building:

11. **Slash command shape.** Discord does not allow a bare word like `mine`
    alongside top-level options, so `/assets` uses subcommands:
    `/assets update [number]`, `/assets mine`, `/assets item name:`,
    `/assets task id: status:`.
12. **Tool calling on the extraction model.** `claude-sonnet-5-5` rejects a
    forced `tool_choice`, so the extraction pass sends `tool_choice: auto`
    with a `strict: true` tool, asks for the call in the prompt, and retries
    once if no call comes back. The schema guarantee is the same; every
    action is validated in code regardless.
13. **Model declines.** If the model declines a batch (rare for this
    content), the batch is marked failed and skipped. A server-side fallback
    model was not added, because it needs a newer SDK than the one the
    existing team-report features run on; upgrading that is a separate change.
14. **Batch timing.** The bot polls once a minute, so a conversation is
    picked up within a minute of going quiet for 3, not at exactly 3.
15. **Never auto-applied.** `flag_unknown` joins `create_content_item` on the
    list that always waits for a person, since accepting one changes nothing.
16. **Item fields that cannot change.** An item's content type and update are
    fixed after creation, because its tasks come from that type's template.
    Archive it and create a new one instead.
