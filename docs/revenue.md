# Revenue

The Revenue page (`/revenue/` on the dashboard) is the standalone Revenue Ops
app moved into DevTrack: revenue share, manual and automatic payouts,
contributions, expenses and cost-share, Salary Pay, dev payouts, balance
checkpoints and the directory of everyone ever paid. The standalone app is
not modified by any of this and keeps running until you stop using it.

## How it was moved

It is a port, not a rewrite. The original is a FastAPI app on SQLite; this
is the same logic on DevTrack's Express and Postgres.

| | Original | Here |
|---|---|---|
| Money rules | `app.py` resolver | `src/revenue/resolver.js`, same order, same arithmetic |
| Routes | `/api/...` | `/api/revenue/...`, same bodies and responses (`src/revenue/api.js`) |
| Tables | `people`, `expenses`, ... | `rev_people`, `rev_expenses`, ... same columns (`src/revenue/schema.js`) |
| Page | `static/index.html` | `revenue/index.html` in the dashboard repo: the original page, pointed at DevTrack |
| Sign-in | none | DevTrack login plus the Revenue access box |

Dates stay text and are compared as text, ids stay integers, and an import
keeps the original ids, so nothing about how a month resolves has changed.

**How it was checked.** The original app and the port were loaded with the
same real backup and asked for every month, every list and every person's
history: identical. Then the same 1,581 edits (expenses, share-term changes
mid-month and from a month forward, firing and reinstating, rules,
contributions, Salary Pay, dev payouts, repayments, deletes) were made to
both and everything compared again: identical, 2,053 responses in all.
`test/revenue/revenue.test.js` repeats the comparison on an invented dataset
against answers saved from the original, so a later change that alters a
number fails a test.

Two deliberate differences: the "what's owed this month" list is ordered by
person (the original's order was whatever SQLite returned), and deleting a
Salary Pay member also deletes their repayment entries (the original
errored).

## Switching it on

| Service | Variable | |
|---|---|---|
| Backend | `REVENUE_ENABLED=true` | Turns on `/api/revenue` and the page. Tables create themselves. |
| Backend | `REVENUE_ASSET_PAYOUT_CATEGORY` | Optional. Category for payouts logged from Discord. Default `Art/Assets`. |

**Who can open it.** The owner always. Anyone else needs the **Revenue** box
ticked on their account under Admin; being an admin is not enough by itself,
because the page shows everyone's share and what each person is paid.
Importing and exporting is for the owner and for admins who have the box.

## Bringing your data over

Revenue, Data & Backup:

1. Download a backup from the standalone site (the daily `revenue_ops_YYYY-MM-DD.db`
   files on the `db-backups` release of the revenue repo are exactly this).
2. Choose the file and press **Check file**. It is opened in your browser and
   only its contents are sent; you are shown what it holds.
3. Press **Replace everything with this file**.

An import replaces everything on the page. It can be repeated: until you
stop entering data on the standalone site, importing its latest backup
brings DevTrack up to date again. Once you start entering data here, stop
importing, because an import would overwrite it. **Download backup** on the
same tab exports everything as JSON, which imports back.

## What DevTrack adds

These only happen when Revenue is switched on.

**Paid asset payouts become expenses.** When a dev's payout request (see
[assets.md](assets.md), Dev payout requests) is marked paid, it is logged on
the Expenses tab the way these were being entered by hand: the payee, the
Robux amount, what it was for, and the Discord request as the receipt link.
The payee is found by Roblox user id first, then by name, and created if the
directory has nobody. Reopening or declining a paid payout removes that
expense. The payout card shows the expense number.

Not logged automatically, and said so on the card: a payout with no amount,
and one whose amount was written in dollars (expenses are kept in Robux).

**Requests show recent payments.** A new payout request lists the last few
expenses already logged for that dev, on the admin card and the Payouts
page. This is the check against paying twice for work paid before requests
went through the bot.

**Devs already in the directory are not asked for a Roblox account.** If the
payee directory has a Roblox user id under the dev's name, the bot uses it
and saves it on the roster.

**The assistant can read payments.** "How much have we paid Ruku", "was
Aizen's shiny model paid for" are answered from the expense log. It reads
payments only: it has no access to shares, salaries or revenue, and cannot
log or change a payment.

Tester payouts (the Payouts page for bug reports) are not logged to Revenue.

## Local run

```bash
node scripts/assets-dev-server.js --revenue-dump path/to/dump.json   # then /dev-login?as=owner&to=revenue
node scripts/assets-dev-server.js --revenue-db path/to/backup.db     # serves it at /dev-revenue-db, to try the page's own import
```
