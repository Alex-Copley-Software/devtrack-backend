# Bug reports from Ticket Tool tickets

Bug reports are filed as Ticket Tool tickets: text channels named
`test-game-0001` / `live-game-0001` under the categories **Test Game
Reports** and **Live Game Reports**. Each ticket becomes one DevTrack report.
Everything that worked on a forum-thread report works on a ticket: status
messages, the leaderboard, `/credit`, `/requestcredit`, `/track`, `/reopen`,
`/syncreport`, report pause, tester QA (the opener is pinged in the ticket
with Fixed / Not fixed) and tester payouts. Forum channels that were already
watched keep working.

## From ticket to report

1. Ticket Tool opens the channel. The bot recognises it by name **and**
   category, so a channel with a matching name elsewhere is ignored.
2. The opener is read from Ticket Tool's welcome message (the person it
   mentions), else from the one member the channel is opened to. Staff who
   write in the ticket first do not become the reporter.
3. 45 seconds after the opener's first message, everything they have written
   so far (and any Ticket Tool form answers) becomes the report: the first
   line is the title, files are attached, and it is tagged `test-game` or
   `live-game`. Later messages from anyone are added to the report's
   conversation.
4. Tickets open before the bot started, or missed, are picked up within ten
   minutes. `/syncreport` in a ticket does it at once.

While reports are paused a new ticket is not logged; the opener is told, and
pinged when reports resume.

## Closing

Five minutes after a ticket's report becomes **resolved** or **declined**,
the bot sends `$delete` in the ticket and waits for Ticket Tool to remove
it. Ticket Tool's post in `test-game-transcripts` / `live-game-transcripts`
is matched to the report by ticket number and linked on it.

The bot reads the whole ticket before sending `$delete`. If Ticket Tool
deletes the ticket but posts no transcript within about 20 seconds, the bot
posts its own (a text file with every message) to the same transcripts
channel, so the report always has one.

Ticket Tool may not obey commands sent by another bot. If the ticket is
still there about a minute after `$delete`, the bot saves its own transcript
and deletes the channel itself. It never deletes a ticket without a
transcript: if none can be saved, the close fails, is retried twice, and then
a note is left in the ticket and on the report for staff.

A report reopened in those five minutes is not closed. A ticket deleted by
hand is recorded as closed.

## Audit

On the report's history: ticket opened (with its name), transcript saved
(with the link), ticket closed (how, and the transcript link), or that it
could not be closed. The report shows a ticket chip and a Transcript link.

## Settings (bot service, all optional)

| Variable | Default | |
|---|---|---|
| `TICKETS_ENABLED` | `true` | `false` turns all of this off. |
| `TICKET_AUTO_CLOSE` | `true` | `false`: reports are tracked, tickets are never closed by the bot. |
| `TICKET_CLOSE_ON` | `resolved,declined` | Which outcomes close a ticket. |
| `TICKET_CLOSE_DELAY_MS` | `300000` | Wait after the outcome before closing. |
| `TICKET_TOOL_SEQUENCE` | `delete` | Ticket Tool commands sent, in order, e.g. `close,transcript,delete`. |
| `TICKET_TOOL_COMMANDS` | `true` | `false`: send no `$` commands and go straight to the bot's own transcript and delete. |
| `TICKET_FALLBACK_CLOSE` | `true` | `false`: never delete a ticket Ticket Tool did not delete. |
| `TICKET_TOOL_PREFIX` | `$` | Ticket Tool's command prefix. |
| `TICKET_SETTLE_MS` | `45000` | How long to wait for the opener's first messages. |
| `TICKET_TEST_CATEGORY_ID`, `TICKET_LIVE_CATEGORY_ID` | | Category ids, if a category is renamed. |
| `TICKET_TEST_TRANSCRIPTS_CHANNEL_ID`, `TICKET_LIVE_TRANSCRIPTS_CHANNEL_ID` | | Transcript channel ids, if a channel is renamed. |

## What the bot needs in Discord

- In both ticket categories: View Channel, Send Messages, Read Message
  History, Add Reactions, and Manage Channels (to delete a ticket when Ticket
  Tool does not).
- In both transcripts channels: View Channel, Send Messages, Embed Links,
  Attach Files, Read Message History.
- For `$delete` to be accepted, Ticket Tool has to treat the DevTrack
  bot as support staff on both panels.
