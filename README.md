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
| DELETE | /api/reports/:id | Delete report |

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

### Notion Tasks
| Method | Route | Description | Auth |
|--------|-------|-------------|------|
| POST | /api/notion/webhook | Notion sends page.created / page.properties_updated events here | X-Notion-Signature header |
| GET | /api/notion-tasks | List synced tasks (filter by ?status=&notionDatabaseId=&assigneeId=&search=) | Bearer token, engineer+ |
| PATCH | /api/notion-tasks/:id | Update a task; writes back to the source Notion page | Bearer token, engineer+ |
| POST | /api/notion-tasks/:id/resync | Retry pushing the current row to Notion after a failed write-back | Bearer token, engineer+ |
| GET | /api/notion-tasks/nicknames | List the Notion "Assigned to" option values, for the admin nickname-mapping dropdown | Bearer token, admin |
| GET | /api/notion-tasks/:id/content | Live page body (text/images) + comments for a task, fetched fresh each time | Bearer token, engineer+ |

Comments require the integration to have "Read comments" enabled under the integration's Capabilities settings in Notion — without it, `/content` still returns page body content and just omits comments (fails gracefully, logged server-side).

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

## Notion Task Sync Setup

### 1. Create the integration
1. Go to https://www.notion.so/my-integrations → New integration → Internal.
2. Copy the integration's secret — this is `NOTION_API_KEY`.

### 2. Share the parent page
1. Open the Notion page that has your task databases nested under it.
2. Click `···` → Connections → add your integration.
   Access is inherited by all child databases automatically.

### 3. Point the backend at your database
`NOTION_DATABASE_ID` should be the **database ID** of the specific database to sync
(not the parent page ID). You can find it in the database's URL:
`notion.so/<workspace>/<DATABASE_ID>?v=...`. Multiple databases can be
comma-separated if you add more later.

Only databases with a `title`-type property, a `Status` property, and an
"Assigned to"-style property are synced meaningfully — see
`src/notion-client.js` for the per-database property-name map
(`DB_PROPERTY_MAP`) if a database uses different property names.

### 4. Register the webhook
1. In the integration settings, add a webhook subscription pointing to:
   `https://<your-railway-domain>/api/notion/webhook`
2. Notion will send a one-time verification request. Check the Railway
   deploy logs for a line like:
   `[Notion Webhook] Verification token received — paste this into your
   Notion integration's webhook settings: <token>`
3. Paste that token into the Notion integration's webhook setup screen to
   confirm the subscription. Once confirmed, Notion will show you the
   webhook's signing secret — set that as `NOTION_WEBHOOK_SECRET`.
4. Subscribe to `page.created` and `page.properties_updated` events.

### 5. Map engineer nicknames
Notion's "Assigned to" field is a multi-select of nicknames, not full names,
so there's no automatic name matching. In the dashboard's Admin page, each
user has a Notion Nickname dropdown (populated from the live option list via
`GET /api/notion-tasks/nicknames`) — set it once per engineer and the sync
will resolve assignees both ways from then on.

### Environment variables (Railway)
```text
NOTION_API_KEY        — the integration's internal secret
NOTION_DATABASE_ID     — target database ID(s), comma-separated
NOTION_WEBHOOK_SECRET  — signing secret shown after webhook verification
```
