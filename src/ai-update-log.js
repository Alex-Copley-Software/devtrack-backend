// ai-update-log.js
// Turns a set of resolved fixes (update-log-db.js) into a player-facing,
// Discord-ready update-log post via the Anthropic API. The team pastes the
// result into Discord by hand, so this targets Discord markdown directly.

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

function buildPrompt(fixes, since, until) {
  return `You are writing a patch-notes style update log post for a Discord announcement channel, for a small game development team (Anime Expeditions). It will be pasted directly into Discord, so use Discord markdown. The covered date range is ${since.toDateString()} to ${until.toDateString()}.

Turn the fixes below into a clean, player-facing message:
- Group into a "🐛 Bug Fixes" section (type bug/crash) and a "✨ Changes" section (type suggestion), omitting either section if it has no entries.
- Each fix is one short bullet ("- ...") in plain language a player would understand — rewrite the internal title/dev-notes rather than copying them verbatim, and don't invent anything not present in the data.
- Include a short header line like "**Update Log — <date range>**" at the top, and nothing else before/after the sections — no long intro or outro.
- Output raw text with Discord markdown only (**bold**, - bullets) — no code fences, no headings with #.

FIXES:
${JSON.stringify(fixes, null, 2)}`;
}

async function generateUpdateLog(fixes, since, until) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
  const message = await getClient().messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: 'user', content: buildPrompt(fixes, since, until) }],
  });
  console.log('[AI Update Log] stop_reason:', message.stop_reason, 'usage:', JSON.stringify(message.usage));
  return message.content.map(block => block.text || '').join('\n').trim();
}

module.exports = { generateUpdateLog };
