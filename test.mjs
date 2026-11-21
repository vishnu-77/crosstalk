// Self-check for the MCP handler: node test.mjs   (no agent is actually called)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BRIDGE_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-')), 'calls.jsonl');
process.env.BRIDGE_AGY_BIN = 'no-such-agy-binary'; // fails fast, so a call is logged without running an agent
process.env.BRIDGE_TIMEOUT_MS = '4000';
const { handle, runAgent, TARGETS, route, toolFor, CANCEL_DIR } = await import('./bridge-mcp.mjs');
// A stand-in agent: `node -p <prompt>` evaluates the prompt, so a prompt can fake Claude's JSON reply or hang.
// It drops the stop rule the bridge appends after "\n\n---\n" (that text isn't code) and remembers the full prompt.
let lastPrompt = '';
TARGETS.fake = { ...TARGETS.claude, bin: () => process.execPath, args: ({ prompt }) => { lastPrompt = prompt; return ['-p', prompt.split('\n\n---\n')[0]]; } };
const { pair } = await import('./calls.mjs');

const init = await handle('agy', { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
assert.equal(init.serverInfo.name, 'bridge-agy');

const { tools } = await handle('claude', { id: 2, method: 'tools/list' });
assert.deepEqual(tools.map((t) => t.name), ['ask_claude']);

const empty = await handle('agy', { id: 3, method: 'tools/call', params: { name: 'ask_agy', arguments: { prompt: ' ' } } });
assert.equal(empty.isError, true);

const badCwd = await handle('agy', { id: 6, method: 'tools/call', params: { name: 'ask_agy', arguments: { prompt: 'x', cwd: 'Z:\\does-not-exist' } } });
assert.match(badCwd.content[0].text, /cwd does not exist/);

await assert.rejects(handle('agy', { id: 4, method: 'tools/call', params: { name: 'ask_other', arguments: { prompt: 'x' } } }));
await assert.rejects(handle('agy', { id: 5, method: 'nope' }));
assert.equal(await handle('agy', { method: 'notifications/initialized' }), undefined);

// A call is logged as start + end and pairs into one failed call from claude to agy.
const r = await handle('agy', { id: 7, method: 'tools/call', params: { name: 'ask_agy', arguments: { prompt: 'log me' } } });
assert.equal(r.isError, true);
const calls = pair(fs.readFileSync(process.env.BRIDGE_LOG, 'utf8').split('\n').filter(Boolean));
assert.equal(calls.length, 2); // the bad-cwd call above is logged too
const last = calls.at(-1);
assert.deepEqual([last.from, last.to, last.status, last.prompt], ['claude', 'agy', 'failed', 'log me']);
assert.ok(last.ms >= 0);
assert.equal(pair(['{"id":"x","event":"start","ts":1,"from":"agy","to":"claude","prompt":"p"}'])[0].status, 'running');

// Happy path parses Claude's JSON and appends the session id.
const fake = await runAgent('fake', { prompt: 'JSON.stringify({ result: "hi", session_id: "s1" })' });
assert.deepEqual([fake.isError, fake.text.split('\n')[0]], [false, 'hi']);
assert.match(fake.text, /fake session: s1/);

// A hung agent is killed at BRIDGE_TIMEOUT_MS, and a cancel stops it at once.
const hang = 'new Promise(r => setTimeout(r, 60000))';
let t = Date.now();
const slow = await runAgent('fake', { prompt: hang });
assert.match(slow.text, /timed out/);
assert.ok(Date.now() - t < 10000, 'timeout should stop the process quickly');
const ac = new AbortController();
setTimeout(() => ac.abort(), 300);
t = Date.now();
const cancelled = await runAgent('fake', { prompt: hang, signal: ac.signal });
assert.match(cancelled.text, /cancelled by the caller/);
assert.ok(Date.now() - t < 3000, 'cancel should beat the timeout');

// Routing: task picks model + effort per target; unknown task falls back to the default; an explicit model wins.
const pick3 = ({ task, model, effort }) => ({ task, model, effort });
assert.deepEqual(pick3(route('claude', 'review')), { task: 'review', model: 'opus', effort: 'high' });
assert.deepEqual(pick3(route('agy', 'quick')), { task: 'quick', model: 'gemini-3.8-flash-low', effort: 'low' });
assert.equal(route('agy', 'nonsense').task, 'code');
assert.equal(route('claude', 'deep', 'fable').model, 'fable');
assert.deepEqual(toolFor('agy').inputSchema.properties.task.enum, ['quick', 'code', 'review', 'research', 'deep']);

// The side pane stops a running call by creating cancel/<id>; the spawned PID and the task/model are logged.
const stopIt = setInterval(() => {
  const lines = fs.readFileSync(process.env.BRIDGE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const running = lines.findLast((e) => e.event === 'spawned');
  if (running && !lines.some((e) => e.event === 'end' && e.id === running.id)) {
    fs.mkdirSync(CANCEL_DIR, { recursive: true });
    fs.writeFileSync(`${CANCEL_DIR}/${running.id}`, '');
    clearInterval(stopIt);
  }
}, 100);
t = Date.now();
const stopped = await runAgent('fake', { prompt: hang, task: 'review' });
assert.match(stopped.text, /stopped from the side pane/);
assert.ok(Date.now() - t < 3500, 'pane stop should beat the timeout');
const last2 = pair(fs.readFileSync(process.env.BRIDGE_LOG, 'utf8').split('\n').filter(Boolean)).at(-1);
assert.equal(last2.status, 'failed');
assert.ok(last2.pid > 0);
assert.equal(last2.task, 'review'); // 'fake' has no routes of its own, so no model/effort; route() is tested above
assert.equal(fs.existsSync(`${CANCEL_DIR}/${last2.id}`), false, 'cancel file is cleaned up');

// Quota: a failed call whose output says the usage limit ran out closes its session and pauses the agent.
const { closedInfo, pausedInfo, resume, closeSession, limitReason } = await import('./state.mjs');
const LOGP = process.env.BRIDGE_LOG;
const quota = await runAgent('fake', { prompt: 'JSON.stringify({ is_error: true, subtype: "error", result: "Claude AI usage limit reached. Try again later.", session_id: "q1" })' });
assert.match(quota.text, /quota or usage limit ran out/);
assert.match(quota.text, /Session q1 is closed/);
assert.match(quota.text, /Tell the user/);
assert.equal(closedInfo(LOGP, 'q1').by, 'quota');
assert.ok(pausedInfo(LOGP, 'fake'), 'agent is paused');
const ends = fs.readFileSync(LOGP, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert.ok(ends.some((e) => e.event === 'limit' && e.session === 'q1'), 'limit event logged');
assert.equal(pair(fs.readFileSync(LOGP, 'utf8').split('\n').filter(Boolean)).at(-1).status, 'quota');

// While paused nothing is started; after Resume calls run again; a closed session is never resumed.
t = Date.now();
const blocked = await runAgent('fake', { prompt: 'JSON.stringify({ result: "should not run" })' });
assert.match(blocked.text, /is paused/);
assert.ok(Date.now() - t < 500, 'refused without spawning');
resume(LOGP, 'fake');
assert.equal(pausedInfo(LOGP, 'fake'), null);
const again = await runAgent('fake', { prompt: 'JSON.stringify({ result: "back", session_id: "q2" })' });
assert.equal(again.isError, false);
const reopen = await runAgent('fake', { prompt: 'JSON.stringify({ result: "x" })', session: 'q1' });
assert.match(reopen.text, /was closed \(quota/);
closeSession(LOGP, { session: 'q2', target: 'fake', by: 'closed by you' });
assert.match((await runAgent('fake', { prompt: '1', session: 'q2' })).text, /closed by you/);

// A successful reply that merely mentions rate limits is not a quota stop; only failed calls are checked.
const talk = await runAgent('fake', { prompt: 'JSON.stringify({ result: "Add a rate limit and handle HTTP 429." })' });
assert.equal(talk.isError, false);
assert.equal(pausedInfo(LOGP, 'fake'), null);
assert.equal(limitReason('everything fine'), null);
assert.equal(limitReason('', { api_error_status: 429 }), 'rate limit (HTTP 429)');
assert.match(limitReason('Error: RESOURCE_EXHAUSTED: Quota exceeded for model'), /RESOURCE_EXHAUSTED/);

// Stop rule: appended to every prompt with the task's limits; the real routes cap Claude's turns and spend.
await runAgent('fake', { prompt: '1' });
assert.match(lastPrompt, /Stop as soon as the task is done/);
const quick = route('claude', 'quick');
assert.deepEqual([quick.maxTurns, quick.budgetUsd, quick.timeoutS], [3, 0.1, 120]);
assert.deepEqual(TARGETS.claude.args({ prompt: 'p', ...quick }).filter((x) => /max|^3$|^0.1$/.test(x)), ['--max-turns', '3', '--max-budget-usd', '0.1']);
assert.ok(TARGETS.agy.args({ prompt: 'p', timeoutS: 120 }).includes('120s'), 'agy gets --print-timeout');

// A cap stopping Claude is reported as a cap, not as a quota stop, and does not pause anything.
const capped = await runAgent('fake', { prompt: 'JSON.stringify({ is_error: true, subtype: "error_max_turns", session_id: "m1", num_turns: 3 })' });
assert.match(capped.text, /stopped at its turn limit/);
assert.equal(pausedInfo(LOGP, 'fake'), null);

// Meter: usage from both CLIs' JSON, logged per call and totalled per agent.
const { usageOf, spentToday } = await import('./bridge-mcp.mjs');
const { meter } = await import('./calls.mjs');
assert.deepEqual(usageOf({ usage: { input_tokens: 9630, output_tokens: 25, thinking_tokens: 24 } }), { inTok: 9630, outTok: 25, thinkTok: 24, costUsd: 0, turns: 0 });
assert.deepEqual(usageOf({ total_cost_usd: 0.07, num_turns: 2, usage: { input_tokens: 6, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 10 } }),
  { inTok: 156, outTok: 10, thinkTok: 0, costUsd: 0.07, turns: 2 });
await runAgent('fake', { prompt: 'JSON.stringify({ result: "ok", total_cost_usd: 0.25, num_turns: 1, usage: { input_tokens: 1000, output_tokens: 50 } })' });
const m = meter(pair(fs.readFileSync(LOGP, 'utf8').split('\n').filter(Boolean)));
assert.ok(m.fake.calls >= 1 && m.fake.costUsd >= 0.25 && m.fake.inTok >= 1000);

// Daily budget: once today's spend reaches dailyBudgetUsd (5 in routes.json), new calls are refused without starting.
fs.appendFileSync(LOGP, JSON.stringify({ ts: Date.now(), id: 'big', event: 'end', to: 'fake', ok: true, usage: { costUsd: 5 } }) + '\n');
assert.ok(spentToday(LOGP) >= 5);
t = Date.now();
assert.match((await runAgent('fake', { prompt: '1' })).text, /budget is used up/);
assert.ok(Date.now() - t < 500);

console.log('ok');
