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

Only the tester who filed the report can answer, and only once per request,
until the request has waited 30 minutes (or whatever `/qadelay` is set to). Then it opens up in QA Requests
(below). A report that comes back to QA Review after a "Not fixed" gets a new request.
Reports with no Discord thread or reporter (imports, manual entries) and
suggestions are skipped. Every request and answer is kept in the **Tester QA
log** on the payouts page.

### QA Requests

A request still unanswered 30 minutes after it was posted is posted in the
**QA Requests** channel, found by name (`qa-requests`) or by
`QA_REQUESTS_CHANNEL_ID` on the bot. The check message in the report's post
says it has opened up.

The wait is changed in Discord by a server admin with `/qadelay minutes:<n>`
(0 to 1440; 0 stops sending checks to QA Requests). `/qadelay` on its own
shows the current wait. It is saved with the other tester QA rules, applies
straight away to checks already waiting, and needs no restart.

- **Take this check** makes it that person's for 30 minutes. They are sent a
  link to the check message, and the QA Requests post and the report's post
  both say who has it. Nobody else can take it in that time; after it,
  anyone can take it over, and the last person to take it is the one who can
  answer.
- They answer in the report's post exactly as the reporter would: their own
  video or photo posted there, then Fixed or Not fixed. Somebody else's
  upload never counts as their proof.
- The reporter can still answer at any point until someone does.
- When the check ends (answered, approved by staff, withdrawn) the QA
  Requests post is deleted, so the channel only shows checks still waiting.
  The outcome is recorded in the report's post.
- The report's history shows it opening up and who took it.

Reports from the old Ticket Tool tickets are never opened up: a ticket is
private, so nobody else could post proof in it.

## Payouts

`/payouts/`, for admins and owners.

- **Pay periods** are named date ranges of any length; both days are
  included, and periods may overlap. Any dates can also be looked at without
  saving a period.
- **Prices** are set per bug level (insignificant, minor, moderate, major)
  and per confirmed fix. A QA approval is paid the fix price.
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
- A confirmed fix is paid once per report, to whoever confirmed it (the
  reporter, or the person who took it in QA Requests), in the period they
  confirmed it. The report itself is still paid to the reporter.
- **QA staff** (dashboard accounts with the QA or Reviewer role) are paid
  the confirmed-fix price once per report, the first time one of them
  resolves it on the dashboard (Verified on QA Review, or Resolve on a
  tester-confirmed report). This is read from the report history, so
  approvals from before this was added count too. A report declined
  afterwards stops counting. Engineers, admins and owners are not paid for
  resolving. QA staff have their own table under the testers, and the total
  owed includes them.

## Rules (Prices and rules tab)

| Rule | Default |
|------|---------|
| Ask testers to confirm fixes | on |
| Fixed and Not fixed need a video or photo (an upload or a link posted in the thread or ticket since the request) | on |
| A tester's Fixed resolves the report | off |
| Pay credited co-finders | on |

## Trying it locally

`node scripts/assets-dev-server.js` also serves `/payouts/` against an
in-memory database with sample reports. `npm test` covers the payout maths,
the period rules and the tester QA flow (`test/tester-pay.test.js`).
