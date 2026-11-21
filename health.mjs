#!/usr/bin/env node
// Fast health check for agy-bridge (no model calls, ~1-2 s). Run at every session start by hooks.
//   node health.mjs           human-readable, exit 1 on failure
//   node health.mjs --claude  Claude Code SessionStart hook JSON
//   node health.mjs --agy     agy SessionStart hook JSON
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG, TARGETS } from './bridge-mcp.mjs';
import { pausedInfo } from './state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, 'bridge-mcp.mjs');
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PLUGIN = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'claude-sync');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const same = (a, b) => path.resolve(a ?? '').toLowerCase() === path.resolve(b ?? '').toLowerCase();

const fails = [];  // bridge broken
const stale = [];  // works, but agy's copy of the Claude setup is out of date

function binRuns(name, bin) {
  // agy's first start can take ~25 s (measured); later ones ~2 s.
  try { execFileSync(bin, ['--version'], { stdio: 'pipe', timeout: 40000, windowsHide: true }); }
  catch (e) { fails.push(`${name} CLI does not run (${bin}): ${e.code ?? e.message}`); }
}

// Start the real server and do the MCP handshake, so a broken bridge file is caught too.
function handshake(target) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BRIDGE, target], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const done = (err) => { clearTimeout(t); p.kill(); if (err) fails.push(`bridge ${target}: ${err}`); resolve(); };
    const t = setTimeout(() => done('no MCP reply within 5 s'), 5000);
    p.on('error', (e) => done(e.message));
    p.stdout.on('data', (d) => {
      out += d;
      const reply = out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m?.id === 2);
      if (reply) done(reply.result?.tools?.[0]?.name === `ask_${target}` ? null : `unexpected tools/list reply`);
    });
    p.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  });
}

function registrations() {
  const cfg = readJson(path.join(CLAUDE_DIR, '.claude.json')) ?? readJson(path.join(os.homedir(), '.claude.json'));
  const agy = cfg?.mcpServers?.agy;
  if (!agy) fails.push('Claude has no "agy" MCP server registered');
  else if (!agy.args?.some((a) => same(a, BRIDGE))) fails.push(`Claude's "agy" MCP server points somewhere else: ${agy.args?.join(' ')}`);

  if (readJson(path.join(PLUGIN, 'plugin.json'))?.name !== 'claude-sync') return fails.push(`agy plugin missing at ${PLUGIN}`);
  const claude = readJson(path.join(PLUGIN, 'mcp_config.json'))?.mcpServers?.claude;
  if (!claude?.args?.some((a) => same(a, BRIDGE))) fails.push('agy plugin has no working "claude" bridge entry');
}

// Compare the Claude sources with agy's copies (same rules sync.mjs uses).
function drift() {
  const md = read(path.join(CLAUDE_DIR, 'CLAUDE.md'));
  const rule = read(path.join(PLUGIN, 'rules', 'claude.md'));
  if (md !== null && rule !== null && !rule.endsWith(md)) stale.push('CLAUDE.md changed');
  const src = path.join(CLAUDE_DIR, 'skills');
  const dst = path.join(PLUGIN, 'skills');
  const names = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((n) => !n.startsWith('.') && fs.existsSync(path.join(d, n, 'SKILL.md'))) : []);
  const have = new Set(names(dst));
  for (const n of names(src)) {
    if (!have.has(n)) stale.push(`new skill ${n}`);
    else if (read(path.join(src, n, 'SKILL.md')) !== read(path.join(dst, n, 'SKILL.md'))) stale.push(`skill ${n} changed`);
  }
}

// --live: a real round trip each way over MCP stdio. The reply must echo a random code word (so the other agent
// really answered) and the call must appear in the log as start + end (so the pane can show it). Costs one tiny call each way.
async function live(target) {
  const word = `PING-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const before = read(LOG)?.length ?? 0;
  const t0 = Date.now();
  const p = spawn(process.execPath, [BRIDGE, target], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const reply = await new Promise((resolve) => {
    let out = '';
    const t = setTimeout(() => resolve({ error: 'no reply within 120 s' }), 120000);
    p.stdout.on('data', (d) => {
      out += d;
      const m = out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x?.id === 2);
      if (m) { clearTimeout(t); resolve(m.result ?? { error: m.error?.message }); }
    });
    p.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: `ask_${target}`, arguments: { prompt: `Reply with exactly: ${word}`, task: 'quick', cwd: os.tmpdir() } } }) + '\n');
  });
  p.stdin.end();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const text = reply.content?.[0]?.text ?? reply.error ?? '';
  if (reply.isError || !text.includes(word)) return fails.push(`live ${target}: reply did not contain ${word}: ${text.slice(0, 200)}`);
  const added = (read(LOG) ?? '').slice(before).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.prompt?.includes(word) || e.reply?.includes(word));
  if (!added.some((e) => e.event === 'start') || !added.some((e) => e.event === 'end' && e.ok)) return fails.push(`live ${target}: answered, but the call is missing from ${LOG}`);
  liveOk.push(`${target === 'agy' ? 'claude -> agy' : 'agy -> claude'} answered ${word} in ${secs}s and was logged`);
}
const liveOk = [];

binRuns('agy', TARGETS.agy.bin());
binRuns('claude', TARGETS.claude.bin());
await Promise.all([handshake('agy'), handshake('claude')]);
registrations();
drift();
// An agent whose quota ran out is paused: not broken, but the user must know before relying on it.
const paused = ['agy', 'claude'].map((t) => pausedInfo(LOG, t)).filter(Boolean)
  .map((p) => `PAUSED ${p.target}: quota/usage limit ran out (${p.reason}); calls refused until ${new Date(p.until).toLocaleTimeString()}. Resume early: node calls.mjs resume ${p.target} or the Resume button in /agy-map`);
if (process.argv.includes('--live') && !fails.length && !paused.length) await Promise.all([live('agy'), live('claude')]);

const fix = `cd ${HERE} && node sync.mjs`;
const lines = [
  ...paused,
  ...liveOk.map((l) => `LIVE ${l}`),
  ...fails.map((f) => `FAIL ${f}`),
  ...(stale.length ? [`STALE agy copy: ${stale.join(', ')}`] : []),
];
const summary = paused.length && !fails.length ? `agy-bridge: ${paused.map((p) => p.split(':')[0].replace('PAUSED ', '')).join(' and ')} paused because the quota ran out; tell the user.`
  : fails.length ?`agy-bridge: ${fails.length} problem(s), ask_agy/ask_claude may not work. Fix: ${fix}`
  : stale.length ? `agy-bridge OK, but agy is behind your Claude setup (${stale.join(', ')}). Run: ${fix}`
  : 'agy-bridge OK (agy + claude CLIs, both bridges, registrations, synced setup)';

const mode = process.argv[2];
if (mode === '--claude') {
  // Shown to the user; the model only hears about it when something is broken.
  console.log(JSON.stringify({
    systemMessage: summary,
    ...((fails.length || paused.length) && { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${summary}\n${lines.join('\n')}` } }),
  }));
} else if (mode === '--agy') {
  const text = [summary, ...lines].join('\n');
  // agy 1.5.14 panics on the documented metadata.user_markdown ("cannot convert string to message"), so plain systemMessage only.
  console.log(JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text } }] }));
} else {
  console.log([summary, ...lines].join('\n'));
  process.exitCode = fails.length ? 1 : 0;
}
