// ai-report.js
// Turns the aggregated activity summary (team-reports-db.js) into a
// readable status report via the Anthropic API.

const Anthropic = require('@anthropic-ai/sdk');
const { fetchWithFreshConnection } = require('./fresh-fetch');

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: fetchWithFreshConnection });
  }
  return client;
}

function buildPrompt(period, start, end, summary) {
  return `You are writing a concise ${period} engineering status report for a small game development team (Anime Expeditions), covering ${start.toDateString()} to ${end.toDateString()}.

Summarize the activity below into a report suitable for a standup. For each engineer, cover what they worked on across three sources: bug/suggestion actions, import assets touched, and Notion tasks touched. Distinguish completed/resolved work from in-progress work where the data shows it. If an engineer has no activity in this period, say so in one short line rather than skipping them.

End with a short team-wide summary (2-3 sentences) on overall pace and any notable patterns (e.g. one person carrying most of the load, a lot of severe-priority items, etc.) if the data supports it — don't invent anything not backed by the data.

Output plain text only — no markdown symbols like # or **. Use engineer names as line headers, blank lines between sections, and simple dashes for bullets, since this is displayed as-is without a markdown renderer.

DATA:
${JSON.stringify(summary, null, 2)}`;
}

async function generateReport(period, start, end, summary) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
  const message = await getClient().messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: buildPrompt(period, start, end, summary) }],
  });
  console.log('[AI Report] stop_reason:', message.stop_reason, 'usage:', JSON.stringify(message.usage), 'blocks:', message.content.map(b => b.type));
  return message.content.map(block => block.text || '').join('\n').trim();
}

module.exports = { generateReport };
