#!/usr/bin/env node
// Agent-to-agent calls and sessions from the bridge log.
//   node calls.mjs [count]          last calls (default 10)      node calls.mjs -f       follow live
//   node calls.mjs sessions         sessions, open or closed     node calls.mjs close <session id>
//   node calls.mjs clear            hide closed sessions         node calls.mjs resume <agy|claude>
//   node calls.mjs meter            today's tokens, cost, time and the daily budget
import fs from 'node:fs';
import path from 'node:path';
import { LOG } from './bridge-mcp.mjs';
import { closeSession, listClosed, pausedInfo, resume, stateDirs } from './state.mjs';

export function pair(lines) {
  const calls = new Map();
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    const c = calls.get(e.id) ?? {};
    if (e.event === 'spawned') { if (calls.has(e.id)) calls.set(e.id, { ...c, pid: e.pid }); continue; }
    if (e.event === 'limit') { if (calls.has(e.id)) calls.set(e.id, { ...c, limitReason: e.reason }); continue; }
    calls.set(e.id, e.event === 'end' ? { ...c, ...e, prompt: c.prompt, cwd: c.cwd, started: c.ts, ended: e.ts }
      : { ...c, ...e, started: e.ts, status: e.event === 'refused' ? 'refused' : 'running' });
  }
  return [...calls.values()].map((c) => ({ ...c, status: c.ended ? (c.limit ? 'quota' : c.ok ? 'ok' : 'failed') : c.status }));
}

// Every session the bridge has seen, newest use last, with its closed state.
export function sessions(lines, closed) {
  const byId = new Map();
  for (const c of pair(lines)) {
    if (!c.session) continue;
    const s = byId.get(c.session) ?? { session: c.session, target: c.to, calls: 0 };
    byId.set(c.session, { ...s, calls: s.calls + 1, lastUsed: c.ended ?? c.started });
  }
  for (const k of closed) byId.set(k.session, { session: k.session, target: k.target, calls: 0, ...byId.get(k.session), closed: k });
  return [...byId.values()].sort((a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0));
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const meterLine = (u) => `${k(u.inTok)} in · ${k(u.outTok)} out · ${k(u.thinkTok)} thinking${u.costUsd ? ` · $${u.costUsd.toFixed(3)}` : ''}${u.turns ? ` · ${u.turns} turns` : ''}`;

// Today's totals per agent being called: calls, tokens, cost, busy time.
export function meter(calls, now = Date.now()) {
  const day = new Date(now).toDateString();
  const out = {};
  for (const c of calls.filter((c) => new Date(c.started).toDateString() === day)) {
    const m = (out[c.to] ??= { calls: 0, inTok: 0, outTok: 0, thinkTok: 0, costUsd: 0, ms: 0 });
    m.calls++; m.ms += c.ms ?? 0;
    for (const f of ['inTok', 'outTok', 'thinkTok', 'costUsd']) m[f] += c.usage?.[f] ?? 0;
  }
  return out;
}

const fmt = (c) => {
  const t = new Date(c.started).toLocaleTimeString();
  const dur = c.ms != null ? `${(c.ms / 1000).toFixed(1)}s` : '…';
  const how = [c.task, c.model, c.effort && `effort ${c.effort}`, c.pid && `pid ${c.pid}`].filter(Boolean).join(' · ');
  return `${t}  ${c.from} -> ${c.to}  ${c.status.padEnd(7)} ${dur.padStart(6)}  depth ${c.depth ?? '?'}${how ? `  [${how}]` : ''}\n   ask: ${(c.prompt ?? '').replace(/\s+/g, ' ').slice(0, 120)}` +
    (c.usage ? `\n   use: ${meterLine(c.usage)}${c.capped ? `  (stopped at ${c.capped})` : ''}` : '') +
    (c.reason ? `\n   why: ${c.reason}` : '') + (c.reply ?`\n   got: ${c.reply.replace(/\s+/g, ' ').slice(0, 120)}` : '');
};
const bar = (f, w = 20) => { const n = Math.round(Math.min(1, Math.max(0, f)) * w); return `[${'█'.repeat(n)}${'░'.repeat(w - n)}]`; };
const read = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : []);
const pausedLines = () => ['agy', 'claude'].map((t) => pausedInfo(LOG, t)).filter(Boolean)
  .map((p) => `PAUSED ${p.target}: ${p.reason} - resumes ${new Date(p.until).toLocaleTimeString()} (node calls.mjs resume ${p.target})`);

if (process.argv[1]?.endsWith('calls.mjs')) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'meter') {
    const { loadRoutes } = await import('./bridge-mcp.mjs');
    const daily = loadRoutes().dailyBudgetUsd;
    const m = meter(pair(read()));
    const total = Object.values(m).reduce((t, x) => t + x.costUsd, 0);
    console.log([...pausedLines(), ...Object.entries(m).map(([to, x]) => `${to.padEnd(6)} ${x.calls} call(s) · ${meterLine(x)} · busy ${(x.ms / 1000).toFixed(0)}s`),
      daily ? `budget ${bar(total / daily)} $${total.toFixed(2)} of $${daily} today` : `spent $${total.toFixed(2)} today (no daily budget set)`].join('\n'));
  } else if (cmd === 'sessions') {
    const list = sessions(read(), listClosed(LOG)).filter((s) => !s.closed?.cleared);
    console.log([...pausedLines(), ...list.map((s) => `${s.closed ? 'closed' : 'open  '}  ${s.target.padEnd(6)} ${s.session}  ${s.calls} call(s)` +
      (s.closed ? `  - ${s.closed.by}${s.closed.reason ? `: ${s.closed.reason}` : ''}` : ''))].join('\n') || 'No sessions yet.');
  } else if (cmd === 'close') {
    if (!arg) { console.error('usage: node calls.mjs close <session id>'); process.exit(2); }
    const s = sessions(read(), []).find((x) => x.session === arg);
    closeSession(LOG, { session: arg, target: s?.target ?? 'unknown', by: 'closed by you' });
    console.log(`Closed ${arg}. The bridge will refuse to resume it.`);
  } else if (cmd === 'clear') {
    // Hides closed sessions from lists; they stay closed (the file remains, marked cleared).
    const dir = stateDirs(LOG).closed;
    const list = listClosed(LOG);
    for (const k of list) fs.writeFileSync(path.join(dir, `${k.session.replace(/[^\w.-]/g, '_')}.json`), JSON.stringify({ ...k, cleared: true }, null, 2) + '\n');
    console.log(`Cleared ${list.length} closed session(s) from the list.`);
  } else if (cmd === 'resume') {
    if (!['agy', 'claude'].includes(arg)) { console.error('usage: node calls.mjs resume <agy|claude>'); process.exit(2); }
    resume(LOG, arg);
    console.log(`${arg} resumed: new calls will be started again.`);
  } else {
    const follow = process.argv.includes('-f');
    const n = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 10);
    let shown = '';
    const draw = () => {
      const out = [...pausedLines(), ...pair(read()).slice(-n).map(fmt)].join('\n\n') || `No calls yet (${LOG}).`;
      if (out !== shown) { if (follow) console.clear(); console.log(out); shown = out; }
    };
    draw();
    if (follow) setInterval(draw, 1000);
  }
}
