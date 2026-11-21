#!/usr/bin/env node
// Stdio MCP server that exposes one tool, ask_<target>, which runs the other agent CLI in print mode.
//   node bridge-mcp.mjs agy     -> registered in Claude Code, lets Claude ask agy
//   node bridge-mcp.mjs claude  -> registered in agy, lets agy ask Claude
// Extra CLI flags (e.g. permission mode) come from BRIDGE_AGY_ARGS / BRIDGE_CLAUDE_ARGS (JSON array).
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { closedInfo, closeSession, limitReason, pause, pausedInfo } from './state.mjs';

const MAX_DEPTH = Number(process.env.BRIDGE_MAX_DEPTH ?? 2); // stops claude->agy->claude->... loops
const depth = Number(process.env.BRIDGE_DEPTH ?? 0);

function claudeBin() {
  if (process.env.BRIDGE_CLAUDE_BIN) return process.env.BRIDGE_CLAUDE_BIN;
  // npm's claude.cmd shim wraps this exe; calling the exe directly avoids cmd.exe quoting of the prompt.
  const exe = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return process.platform === 'win32' && existsSync(exe) ? exe : 'claude';
}

// Every call is appended here as a start line and an end line, whichever agent made it; the pane and calls.mjs read it.
export const LOG = process.env.BRIDGE_LOG || join(homedir(), '.agy-bridge', 'calls.jsonl');
const clip = (s, n = 400) => (s && s.length > n ? s.slice(0, n) + '…' : s ?? '');
function logEvent(ev) {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    if (existsSync(LOG) && statSync(LOG).size > 5 * 1024 * 1024) renameSync(LOG, LOG + '.1'); // keep one old file
    appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...ev }) + '\n'); }
  catch { /* tracking must never break a call */ }
}

// The side pane asks to stop a call by creating cancel/<call id>; runAgent watches for it.
export const CANCEL_DIR = join(dirname(LOG), 'cancel');

// Task -> model + effort, per target. Re-read on every call so edits to routes.json apply without a restart.
const ROUTES = process.env.BRIDGE_ROUTES || join(dirname(fileURLToPath(import.meta.url)), 'routes.json');
export function loadRoutes() { try { return JSON.parse(readFileSync(ROUTES, 'utf8')); } catch { return {}; } }
export function route(target, task, model) {
  const r = loadRoutes();
  const t = r.tasks?.[task] ? task : (r.default ?? 'code');
  const pick = r[target]?.[t] ?? {};
  return {
    task: t, model: model || pick.model, effort: pick.effort,
    timeoutS: pick.timeoutS, maxTurns: pick.maxTurns, budgetUsd: pick.budgetUsd, stopRule: r.stopRule,
  };
}

// Tokens, cost and turns from either CLI's JSON, in one shape for the meter.
export function usageOf(j) {
  const u = j?.usage ?? {};
  const inTok = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? u.cache_read_tokens ?? 0);
  return { inTok, outTok: u.output_tokens ?? 0, thinkTok: u.thinking_tokens ?? u.output_tokens_details?.thinking_tokens ?? 0, costUsd: j?.total_cost_usd ?? 0, turns: j?.num_turns ?? 0 };
}

// Today's spend from the log, so a daily budget can stop new calls (like a quota pause, but set by you).
export function spentToday(log = LOG, now = Date.now()) {
  const day = new Date(now).toDateString();
  let usd = 0;
  try {
    for (const l of readFileSync(log, 'utf8').split('\n')) {
      if (!l.includes('"costUsd"')) continue;
      const e = JSON.parse(l);
      if (e.event === 'end' && new Date(e.ts).toDateString() === day) usd += e.usage?.costUsd ?? 0;
    }
  } catch { /* no log yet */ }
  return usd;
}

const extra = (name) => { try { return JSON.parse(process.env[name] || '[]'); } catch { return []; } };

export const TARGETS = {
  agy: {
    bin: () => process.env.BRIDGE_AGY_BIN || 'agy',
    label: 'Antigravity CLI (agy, Gemini models)',
    args: ({ prompt, session, model, effort, timeoutS }) => [
      `--print=${prompt}`, '--output-format', 'json',
      ...(timeoutS ? ['--print-timeout', `${timeoutS}s`] : []),
      ...(session ? ['--conversation', session] : []),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
      ...extra('BRIDGE_AGY_ARGS'),
    ],
    parse: (j) => ({ text: j.response ?? '', session: j.conversation_id, error: j.status && j.status !== 'SUCCESS' ? j.status : null }),
  },
  claude: {
    bin: claudeBin,
    label: 'Claude Code',
    args: ({ prompt, session, model, effort, maxTurns, budgetUsd }) => [
      '-p', prompt, '--output-format', 'json',
      ...(effort ? ['--effort', effort] : []),
      ...(maxTurns ? ['--max-turns', String(maxTurns)] : []),
      ...(budgetUsd ? ['--max-budget-usd', String(budgetUsd)] : []),
      // Lean by default: no MCP servers (so it can't call agy back) and no skills. Measured on this profile:
      // $0.37 / 15.4 s -> $0.07 / 8.5 s per call. BRIDGE_LEAN=0 gives the called Claude your full setup.
      ...(process.env.BRIDGE_LEAN === '0' ? [] : ['--strict-mcp-config', '--disable-slash-commands']),
      ...(session ? ['--resume', session] : []),
      ...(model ? ['--model', model] : []),
      ...extra('BRIDGE_CLAUDE_ARGS'),
    ],
    parse: (j) => ({ text: j.result ?? '', session: j.session_id, error: j.is_error ? (j.subtype || 'error') : null }),
  },
};

const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS ?? 15 * 60 * 1000);
// How long an agent stays paused after its quota runs out. shortcut: a fixed wait, since neither CLI reports its reset time.
const PAUSE_MS = Number(process.env.BRIDGE_PAUSE_MS ?? 30 * 60 * 1000);
const clock = (ms) => new Date(ms).toLocaleTimeString();

// Kill the agent and everything it started (its own MCP servers, shells), not just the top process.
function killTree(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGTERM');
}

// Every call is logged here, so the MCP tool and scripts that call runAgent directly both show in the pane.
export async function runAgent(target, a) {
  const id = randomUUID();
  const from = target === 'agy' ? 'claude' : 'agy';
  const t0 = Date.now();
  const { task, model, effort, timeoutS, maxTurns, budgetUsd, stopRule } = route(target, a.task, a.model);
  const limits = { timeoutS, maxTurns, budgetUsd };
  const refuse = (reason, text) => {
    logEvent({ id, event: 'refused', from, to: target, depth, task, model, session: a.session, reason, prompt: clip(a.prompt) });
    return { isError: true, text };
  };
  const paused = pausedInfo(LOG, target);
  if (paused) {
    return refuse(`paused: ${paused.reason}`, `${target} is paused because its quota or usage limit ran out (${paused.reason}). ` +
      `Nothing was started. It resumes at ${clock(paused.until)}; to retry sooner press Resume in /agy-map or run "node calls.mjs resume ${target}". Tell the user.`);
  }
  const closed = closedInfo(LOG, a.session);
  if (closed) {
    return refuse(`session closed (${closed.by})`, `${target} session ${a.session} was closed (${closed.by}${closed.reason ? `: ${closed.reason}` : ''}) and is kept closed. ` +
      'Call again without "session" to start a new conversation.');
  }
  const daily = loadRoutes().dailyBudgetUsd;
  const spent = daily ? spentToday() : 0;
  if (daily && spent >= daily) {
    return refuse('daily budget used', `Today's agent budget is used up ($${spent.toFixed(2)} of $${daily}). Nothing was started. ` +
      'Raise "dailyBudgetUsd" in routes.json, or wait until tomorrow. Tell the user.');
  }
  logEvent({ id, event: 'start', from, to: target, depth, task, model, effort, limits, cwd: a.cwd || process.cwd(), session: a.session, prompt: clip(a.prompt) });
  // The stop rule tells the agent when it is done; the limits above make sure it stops even if it doesn't listen.
  const limitText = [maxTurns && `${maxTurns} turns`, budgetUsd && `$${budgetUsd}`, timeoutS && `${timeoutS}s`].filter(Boolean).join(', ');
  const prompt = stopRule ? `${a.prompt}\n\n---\n${stopRule}${limitText ? ` Limits for this task: ${limitText}.` : ''}` : a.prompt;
  const pane = new AbortController();
  const cancelFile = join(CANCEL_DIR, id);
  const watch = setInterval(() => { if (existsSync(cancelFile)) pane.abort('stopped from the side pane'); }, 1000);
  const signal = AbortSignal.any([pane.signal, ...(a.signal ? [a.signal] : [])]);
  try {
    const r = await spawnAgent(target, { ...a, prompt, model, effort, ...limits, signal, onSpawn: (pid) => logEvent({ id, event: 'spawned', pid }) });
    const usage = r.json ? usageOf(r.json) : undefined;
    // Claude ends with subtype error_max_turns / error_max_budget_usd when a cap stops it: say so instead of a bare error.
    const capped = /max_turns|max_budget/.test(r.json?.subtype ?? '') ? (r.json.subtype.includes('turns') ? `turn limit${maxTurns ? ` (${maxTurns})` : ''}` : `budget limit${budgetUsd ? ` ($${budgetUsd})` : ''}`) : null;
    if (capped) r.text = `${target} stopped at its ${capped} for the "${task}" task. ${r.text}\nGive it a narrower task, or use a bigger task type (e.g. "deep").`;
    const why = r.isError && !signal.aborted && !capped ? limitReason(r.raw, r.json) : null;
    if (why) {
      // Quota ran out: close the session for good, pause the agent so nothing new is started, and say so plainly.
      const session = r.session || a.session;
      closeSession(LOG, { session, target, by: 'quota', reason: why });
      const until = pause(LOG, { target, reason: why, ms: PAUSE_MS });
      logEvent({ id, event: 'limit', from, to: target, session, reason: why, until });
      r.text = `${target} stopped: its quota or usage limit ran out (${why}). ` +
        `${session ? `Session ${session} is closed and will not be resumed. ` : ''}` +
        `Calls to ${target} are paused until ${clock(until)}; press Resume in /agy-map or run "node calls.mjs resume ${target}" to retry sooner. Tell the user.`;
    }
    logEvent({ id, event: 'end', from, to: target, ms: Date.now() - t0, ok: !r.isError, ...(why && { limit: true }), ...(capped && { capped }), usage, session: r.session || a.session, reply: clip(r.text.replace(/\n\n\[\w+ session: .*\]$/, '')) });
    return r;
  } finally {
    clearInterval(watch);
    rmSync(cancelFile, { force: true });
  }
}

function spawnAgent(target, { prompt, cwd, session, model, effort, timeoutS, maxTurns, budgetUsd, signal, onSpawn }) {
  const t = TARGETS[target];
  // spawn reports a missing cwd as ENOENT on the binary, which misleads; check it first.
  if (cwd && !existsSync(cwd)) return Promise.resolve({ isError: true, text: `cwd does not exist: ${cwd}` });
  // The task's own timeout (plus a little grace for the CLI to finish) wins when it is shorter than the global one.
  const limitMs = Math.min(TIMEOUT_MS, timeoutS ? timeoutS * 1000 + 30000 : Infinity);
  const stop = AbortSignal.any([AbortSignal.timeout(limitMs), ...(signal ? [signal] : [])]);
  return new Promise((resolve) => {
    // shortcut: prompt goes on argv, so Windows caps it near 32K chars; switch to stdin/stream-json if that bites.
    const child = spawn(t.bin(), t.args({ prompt, session, model, effort, timeoutS, maxTurns, budgetUsd }), {
      cwd: cwd || process.cwd(),
      env: { ...process.env, BRIDGE_DEPTH: String(depth + 1) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.on('spawn', () => onSpawn?.(child.pid));
    const onStop = () => killTree(child);
    stop.addEventListener('abort', onStop, { once: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ isError: true, text: `Could not start ${t.bin()}: ${e.message}` }));
    child.on('close', (code) => {
      stop.removeEventListener('abort', onStop);
      if (stop.aborted) {
        const why = typeof stop.reason === 'string' ? stop.reason
          : signal?.aborted ? 'cancelled by the caller' : `timed out after ${Math.round(limitMs / 1000)} s (the task's timeoutS, or BRIDGE_TIMEOUT_MS)`;
        return resolve({ isError: true, text: `${target} ${why}; its process tree was stopped.` });
      }
      const line = out.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
      const raw = `${out}\n${err}`; // what limitReason() searches when the call failed
      let r, json;
      try { json = JSON.parse(line); r = t.parse(json); } catch {
        return resolve({ isError: true, raw, text: `${target} exited ${code} without JSON.\n${(err || out).slice(-2000)}` });
      }
      const tail = r.session ? `\n\n[${target} session: ${r.session} - pass as "session" to continue]` : '';
      resolve({ isError: !!r.error, raw, json, session: r.session, text: (r.error ? `${target} reported ${r.error}\n` : '') + r.text.trim() + tail });
    });
  });
}

export function toolFor(target) {
  const r = loadRoutes();
  const tasks = r.tasks ?? {};
  const menu = Object.entries(tasks).map(([k, d]) => `${k} (${r[target]?.[k]?.model ?? 'default model'}): ${d}`).join('; ');
  return {
    name: `ask_${target}`,
    description: `Hand a task or question to ${TARGETS[target].label}, another coding agent with its own tools, and get its final answer. ` +
      'Use for a second opinion, a review, or to delegate work. It runs to completion in the given directory. ' +
      'Set "task" so the right model is used. Pass the returned session id as "session" to continue the same conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Full, self-contained instructions; the other agent does not see this conversation.' },
        task: { type: 'string', ...(Object.keys(tasks).length && { enum: Object.keys(tasks) }), description: `Kind of work; picks the model and effort. ${menu}. Default: ${r.default ?? 'code'}.` },
        cwd: { type: 'string', description: 'Absolute working directory for the other agent. Defaults to this server\'s directory.' },
        session: { type: 'string', description: 'Session/conversation id from an earlier answer, to continue it.' },
        model: { type: 'string', description: 'Optional model override; wins over the task\'s model.' },
      },
      required: ['prompt'],
    },
  };
}

export async function handle(target, msg, signal) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `bridge-${target}`, version: '1.0.0' } };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: [toolFor(target)] };
  if (method === 'tools/call') {
    if (params?.name !== `ask_${target}`) throw { code: -32602, message: `Unknown tool ${params?.name}` };
    const a = params.arguments ?? {};
    if (typeof a.prompt !== 'string' || !a.prompt.trim()) return { isError: true, content: [{ type: 'text', text: 'prompt is required' }] };
    if (depth >= MAX_DEPTH) {
      logEvent({ id: randomUUID(), event: 'refused', from: target === 'agy' ? 'claude' : 'agy', to: target, depth, prompt: clip(a.prompt) });
      return { isError: true, content: [{ type: 'text', text: `Refused: agent call depth ${depth} reached BRIDGE_MAX_DEPTH=${MAX_DEPTH}. Answer yourself instead.` }] };
    }
    const r = await runAgent(target, { ...a, signal });
    return { isError: r.isError, content: [{ type: 'text', text: r.text }] };
  }
  if (id === undefined) return undefined; // notification
  throw { code: -32601, message: `Method not found: ${method}` };
}

if (process.argv[1]?.endsWith('bridge-mcp.mjs')) { // run as server, not when imported by test.mjs
  const target = process.argv[2];
  if (!TARGETS[target]) { console.error('usage: bridge-mcp.mjs agy|claude'); process.exit(2); }
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const inFlight = new Map(); // request id -> AbortController, so a cancel stops that agent
  createInterface({ input: process.stdin })
    .on('line', async (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      if (msg.method === 'notifications/cancelled') return inFlight.get(msg.params?.requestId)?.abort();
      const ac = new AbortController();
      if (msg.id !== undefined) inFlight.set(msg.id, ac);
      try {
        const result = await handle(target, msg, ac.signal);
        // MCP: no reply to a request the client cancelled.
        if (msg.id !== undefined && result !== undefined && !ac.signal.aborted) send({ jsonrpc: '2.0', id: msg.id, result });
      } catch (e) {
        if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: e.message ?? String(e) } });
      } finally {
        inFlight.delete(msg.id);
      }
    })
    // The host went away (session closed): stop every agent still running instead of leaving orphans.
    .on('close', () => { for (const ac of inFlight.values()) ac.abort(); });
}
