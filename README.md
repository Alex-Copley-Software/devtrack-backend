# DevTrack Backend API

## Setup Instructions

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Then edit `.env` and fill in:
- `DATABASE_URL` — your PostgreSQL connection string
- `JWT_SECRET` — any long random string (e.g. run `openssl rand -base64 32`)
- `BOT_SECRET` — a shared secret your Discord bot will use
- `CORS_ORIGIN` — URL of your dashboard (e.g. http://localhost:5500)

**If using Railway for PostgreSQL:**
1. Go to railway.app → New Project → PostgreSQL
2. Click the database → Variables tab → Copy DATABASE_URL
3. Paste it into your .env

### 3. Push database schema
```bash
npm run db:push
```

### 4. Seed engineer accounts
```bash
npm run db:seed
```
This creates 5 engineer accounts. Default password: `devtrack123`

### 5. Start the server
```bash
npm run dev        # development with auto-reload
npm start          # production
```
Server runs at http://localhost:3001

---

## API Reference

### Auth
| Method | Route | Description |
|--------|-------|-------------|
| POST | /api/auth/login | Login → returns JWT token |
| POST | /api/auth/register | Create new engineer account |
| GET | /api/auth/me | Get current user (requires token) |

### Reports
| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/reports | List all reports (supports ?type=bug&status=open&search=) |
| GET | /api/reports/:id | Get single report |
| POST | /api/reports | Create report (supports file uploads) |
| PATCH | /api/reports/:id | Update status, priority, assignees |
| POST | /api/reports/:id/upvote | Increment upvote count |
| POST | /api/reports/:id/archive | Archive a report — excluded from Overview/counts, kept forever, admin/engineer only |
| POST | /api/reports/:id/unarchive | Restore an archived report to active |
| DELETE | /api/reports/:id | Delete report |

Whenever a bug/crash report moves into QA Review (single PATCH or the
"Send to QA" bulk action), a summarized patch note — title, type, severity,
category, assignee, and dev notes (falling back to the report description)
— is posted to the bot's `patch-fixes` Discord channel, with no dashboard
link, so the server has a running log of what's being tested. Configured via
`PATCH_FIXES_CHANNEL_ID` on the bot service (defaults to the current
`patch-fixes` channel if unset).

### Tasks
| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/tasks | All tasks for all engineers |
| GET | /api/tasks/my | Current user's tasks only |
| POST | /api/tasks | Create task |
| PATCH | /api/tasks/:id | Toggle done, update text |
| DELETE | /api/tasks/:id | Delete task |

### Users
| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/users | List all engineers with task/report counts |

### Bot Webhook
| Method | Route | Description | Auth |
|--------|-------|-------------|------|
| POST | /api/bot/report | Discord bot submits new report | x-bot-secret header |

### Board Tasks
| Method | Route | Description | Auth |
|--------|-------|-------------|------|
| GET | /api/board-tasks | List cards (filter by ?status=&assigneeId=&tag=&search=) | Bearer token, engineer+ |
| GET | /api/board-tasks/tags | Distinct tags currently in use, for the filter dropdown and tag autocomplete | Bearer token, engineer+ |
| POST | /api/board-tasks | Create a card | Bearer token, engineer+ |
| PATCH | /api/board-tasks/:id | Update any subset of fields (title/status/details/notionUrl/assigneeId/tags); drag-and-drop status changes go through here too | Bearer token, engineer+ |
| DELETE | /api/board-tasks/:id | Delete a card | Bearer token, engineer+ |

A native dev task board — no external sync. Each card has a title, one of five fixed statuses (Needs Prerequisite / To Do / In Progress / Done / Archive), a single assignee, freeform tags, an optional Notion link (clicking a card with one set opens it directly; clicking a card without one opens the edit form instead), and a free-text details field. Every create/status/assignee/tag/title change is logged to `BoardTaskHistory`, which also feeds Team Reports.

### Team Reports
| Method | Route | Description | Auth |
|--------|-------|-------------|------|
| GET | /api/team-reports | List past generated reports (most recent 20) | Bearer token, admin |
| POST | /api/team-reports/generate | Gather engineer activity for the period and generate a new AI report | Bearer token, admin |

`period` in the POST body is `"daily"` (last 24h) or `"weekly"` (last 7 days, default). All three sources have real audit trails: `ReportHistory` (bugs/suggestions — status, priority, bug level, assignment, dev notes), `ImportHistory` (queued/ready/imported, assignment, other edits), and `BoardTaskHistory` (title/status/assignee/tag transitions on the dev task board). Requires `ANTHROPIC_API_KEY`.

### Roblox Webhook Dump
| Method | Route | Description | Auth |
|--------|-------|-------------|------|
| POST | /api/roblox-dump/webhook | Roblox posts arbitrary JSON here (game content snapshots, debug dumps, etc) | `x-roblox-secret` header |
| GET | /api/roblox-dump | List dumps (id/eventType/robloxUserId/createdAt/payloadSize, no payload) — supports `?eventType=` | Bearer token, `admin` page access |
| GET | /api/roblox-dump/event-types | Distinct event types seen so far, for the filter dropdown | Bearer token, `admin` page access |
| GET | /api/roblox-dump/:id | Full record including the payload | Bearer token, `admin` page access |
| DELETE | /api/roblox-dump/:id | Delete a dump | Bearer token, `admin` page access |

Pure audit/debug log — there's no "import into DevTrack entities" step, since DevTrack doesn't model game content (units/equipment/etc). Admins just view the payload as beautified JSON on the dashboard's Admin page. Requires `ROBLOX_WEBHOOK_SECRET`.

**Roblox side (Lua, `HttpService`):**
```lua
local HttpService = game:GetService("HttpService")

local payload = {
    eventType = "units_snapshot", -- whatever label you want to filter by later
    userId = tostring(game.CreatorId), -- optional, any identifying string
    data = yourDataTable, -- the actual content — units, equipment, whatever
}

local body = HttpService:JSONEncode(payload)

local ok, response = pcall(function()
    return HttpService:RequestAsync({
        Url = "https://devtrack-backend-production.up.railway.app/api/roblox-dump/webhook",
        Method = "POST",
        Headers = {
            ["Content-Type"] = "application/json",
            ["x-roblox-secret"] = "<ROBLOX_WEBHOOK_SECRET value>",
        },
        Body = body,
    })
end)

if not ok or not response.Success then
    warn("[RobloxDump] Failed to send:", ok and response.StatusMessage or response)
end
```
`HttpService.HttpEnabled` must be turned on in Game Settings, and this needs to run from a script with HTTP access (a server script, or Studio's command bar / a plugin for one-off manual dumps).

---

## Authentication
All `/api/*` routes (except /api/auth/login and /api/bot/*) require:
```
Authorization: Bearer <token>
```

Bot routes use:
```
x-bot-secret: <your BOT_SECRET from .env>
```

---

## Deployment (Railway)
1. Push this folder to GitHub
2. railway.app → New Project → Deploy from GitHub
3. Add all .env variables in the Railway dashboard
4. Railway auto-detects Node.js and runs `npm start`

---

## Board Tasks (formerly Notion-synced)

The Tasks page used to be a two-way Notion sync (webhook + REST write-back,
`NOTION_API_KEY`/`NOTION_DATABASE_ID`/`NOTION_WEBHOOK_SECRET`/
`NOTION_ENGINEER_NICKNAMES`, engineer nickname mapping in Admin). That
integration has been removed entirely — the Tasks page is now a fully
native DevTrack kanban board (`BoardTask`/`BoardTaskHistory`, see the route
table above) with no external dependency or setup required. The old synced
data was migrated once into the new table via
`scripts/migrate-notion-tasks-to-board.js` and the original `NotionTask`/
`NotionTaskHistory` rows are left in place in Postgres (unused, not deleted)
in case anything needs to be cross-referenced later.

## AI Team Reports Setup

Get an API key from https://console.anthropic.com and set it on Railway:
```text
ANTHROPIC_API_KEY — your Anthropic API key
ANTHROPIC_MODEL    — optional, defaults to claude-sonnet-5
```
