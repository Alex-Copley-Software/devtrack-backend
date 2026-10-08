# Tester QA and tester payouts

Two linked additions to the bug-report side of DevTrack. Code:
`src/tester-pay.js` (data and rules), `src/tester-qa.js` (hooks into report
status changes), `src/routes/payouts.js`, `devtrack-bot/src/qa-check.js`, and
the dashboard page at `/payouts/`.

## Tester QA

When a bug or crash report moves to **QA Review**, the bot pings the tester
who filed it, in that report's own Discord thread, with **Fixed** and **Not
fixed** buttons.

- **Fixed.** The tester posts a video in the thread, then presses Fixed. The
  report shows under **Tester Approved** in the bug nav, with a link to the
  video, for staff to resolve. With the rule *A tester's Fixed resolves the
  report* switched on, it is resolved and published straight away instead.
- **Not fixed.** The tester says what still happens. The report goes back to
  In Progress with their note in its history.
- **Staff resolve it first.** The buttons are retired and the tester is told
  staff approved the fix. It is logged as approved by staff, and not paid.
- **The report leaves QA Review another way** (on hold, back to in progress,
  declined). The request is withdrawn.

Only the tester who filed the report can answer, and only once per request.
A report that comes back to QA Review after a "Not fixed" gets a new request.
Reports with no Discord thread or reporter (imports, manual entries) and
suggestions are skipped. Every request and answer is kept in the **Tester QA
log** on the payouts page.

## Payouts

`/payouts/`, for admins and owners.

- **Pay periods** are named date ranges of any length; both days are
  included, and periods may overlap. Any dates can also be looked at without
  saving a period.
- **Prices** are set per bug level (insignificant, minor, moderate, major)
  and per confirmed fix.
- A period's table shows, per tester, accepted reports by level, fixes
  confirmed, and the amount owed. Click a tester for the reports behind the
  number. **Export CSV** downloads the table.
- **Mark as paid** freezes the period's numbers at that moment, so later
  price changes or re-levelled reports do not alter what was paid. **Reopen**
  discards the frozen copy and recalculates.

What counts:

- Bugs and crashes only, once accepted. A report counts on the day it was
  **accepted** (UTC), not the day it was filed. One declined afterwards stops
  counting.
- A report accepted without a bug level counts for nothing until a level is
  set; it is flagged in the table.
- A credited co-finder (`/credit`) is paid as well as the reporter, unless
  *Pay credited co-finders* is switched off.
- A confirmed fix is paid once per report, to the tester who confirmed it, in
  the period they confirmed it.

## Rules (Prices and rules tab)

| Rule | Default |
|------|---------|
| Ask testers to confirm fixes | on |
| Fixed needs a video (an upload or a video link in the thread since the request) | on |
| A tester's Fixed resolves the report | off |
| Pay credited co-finders | on |

## Trying it locally

`node scripts/assets-dev-server.js` also serves `/payouts/` against an
in-memory database with sample reports. `npm test` covers the payout maths,
the period rules and the tester QA flow (`test/tester-pay.test.js`).
