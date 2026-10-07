// The two Claude calls the agent makes per batch. Prompts live in
// ../prompts/*.md so they can be tuned without touching this file.
//
//   filter   fast, cheap model: is this conversation about content, assets or task progress?
//   extract  stronger model with a strict tool: the proposed tracker actions as JSON

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { fetchWithFreshConnection } = require('../../fresh-fetch');
const { SUGGESTION_TYPES } = require('../constants');

const FILTER_MODEL = () => process.env.ASSET_AGENT_FILTER_MODEL || 'claude-haiku-4-5-20251001';
const EXTRACT_MODEL = () => process.env.ASSET_AGENT_EXTRACT_MODEL || 'claude-sonnet-5-5';
const REQUEST_TIMEOUT_MS = 120000;

const prompts = {};
function loadPrompt(name) {
  if (!prompts[name]) prompts[name] = fs.readFileSync(path.join(__dirname, '../prompts', `${name}.md`), 'utf8').trim();
  return prompts[name];
}

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    // Fresh connection per request: keep-alive sockets go stale on Railway (see fresh-fetch.js).
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: fetchWithFreshConnection });
  }
  return client;
}

// strict: true makes the API guarantee the tool input matches this schema.
// Every field is a required plain string or number (empty string when it
// does not apply) to stay inside what strict schemas support.
const str = description => ({ type: 'string', description });
const ACTION_TOOL = {
  name: 'propose_tracker_actions',
  description: 'Propose changes to the asset tracker based on the conversation. Call exactly once. Use an empty actions list if nothing should change.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['actions'],
    properties: {
      actions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'task_ref', 'status', 'assignee', 'due_date', 'note', 'blocker_reason', 'item_internal_name',
            'display_name', 'content_type', 'update_number', 'confidence', 'reason', 'evidence'],
          properties: {
            type: { type: 'string', enum: SUGGESTION_TYPES },
            task_ref: str('Task ref number from the tracker state, without the #. Empty for create_content_item and flag_unknown.'),
            status: str('New status for update_task_status, else empty.'),
            assignee: str('Roster name for assign_task, else empty.'),
            due_date: str('YYYY-MM-DD for set_due_date, else empty.'),
            note: str('Note text for add_task_note or flag_unknown, else empty.'),
            blocker_reason: str('What is blocking the task, for mark_blocked, else empty.'),
            item_internal_name: str('Internal name of the new item for create_content_item, else empty.'),
            display_name: str('Display name of the new item if mentioned, else empty.'),
            content_type: str('Content type for create_content_item, else empty.'),
            update_number: str('Update number for create_content_item, else empty.'),
            confidence: { type: 'number', description: 'How sure you are a lead would accept this, from 0 to 1.' },
            reason: str('One short sentence explaining the action.'),
            evidence: { type: 'array', items: { type: 'string' }, description: 'Message labels that support this action, e.g. ["m3"].' },
          },
        },
      },
    },
  },
};

function addUsage(total, usage = {}) {
  for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    total[key] = (total[key] || 0) + (usage[key] || 0);
  }
  return total;
}

function assertUsable(message) {
  // A safety decline arrives as a normal 200 response.
  if (message.stop_reason === 'refusal') throw new Error(`Model declined the request (${message.stop_details?.category || 'no category'})`);
  if (message.stop_reason === 'max_tokens') throw new Error('Model ran out of output tokens');
}

async function filter(batchText) {
  const model = FILTER_MODEL();
  const message = await getClient().messages.create({
    model,
    max_tokens: 32,
    system: loadPrompt('filter'),
    messages: [{ role: 'user', content: batchText }],
  }, { timeout: REQUEST_TIMEOUT_MS });
  // Only the first word matters here. If the model starts explaining itself
  // and is cut off, that is still an answer, not a failure.
  if (message.stop_reason !== 'max_tokens') assertUsable(message);
  const answer = message.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim().toUpperCase();
  // Anything that is not a clear SKIP goes on to the careful pass.
  return { relevant: !answer.startsWith('SKIP'), model, usage: message.usage };
}

async function extract({ trackerState, batchText, today }) {
  const model = EXTRACT_MODEL();
  const usage = {};
  const request = reminder => {
    const params = {
      model,
      max_tokens: 16000,
      // The instructions and tracker state come first and are cached: batches
      // from different channels minutes apart share them.
      system: [
        { type: 'text', text: loadPrompt('extract') },
        { type: 'text', text: `TRACKER STATE\n\n${trackerState}`, cache_control: { type: 'ephemeral' } },
      ],
      tools: [ACTION_TOOL],
      // This model rejects a forced tool choice, so the prompt asks for the
      // call and we check that one was made.
      tool_choice: { type: 'auto' },
      messages: [{
        role: 'user',
        content: `Today is ${today}.\n\nCONVERSATION\n\n${batchText}\n\nCall propose_tracker_actions once with the changes you would make.${reminder ? ' Reply only with that tool call.' : ''}`,
      }],
    };
    const effort = process.env.ASSET_AGENT_EXTRACT_EFFORT || 'medium';
    if (effort !== 'off') params.output_config = { effort };
    return getClient().messages.create(params, { timeout: REQUEST_TIMEOUT_MS });
  };

  for (const reminder of [false, true]) {
    const message = await request(reminder);
    addUsage(usage, message.usage);
    assertUsable(message);
    const call = message.content.find(b => b.type === 'tool_use' && b.name === ACTION_TOOL.name);
    if (call) return { actions: Array.isArray(call.input?.actions) ? call.input.actions : [], model, usage };
  }
  // Two answers without a tool call: treat it as "nothing to change".
  return { actions: [], model, usage, noToolCall: true };
}

module.exports = { filter, extract, ACTION_TOOL, FILTER_MODEL, EXTRACT_MODEL };
