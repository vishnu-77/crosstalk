// Session and pause state, kept as small JSON files beside the call log so the bridge, the side pane
// (which can write files but not delete them) and calls.mjs all see the same thing:
//   ~/.crosstalk/closed/<session id>.json   a session that must never be resumed (quota, closed by you, /clear)
//   ~/.crosstalk/paused/<agent>.json        calls to that agent are refused until `until` (quota ran out)
import fs from 'node:fs';
import path from 'node:path';

export function stateDirs(log) {
  const root = path.dirname(log);
  return { closed: path.join(root, 'closed'), paused: path.join(root, 'paused') };
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const safe = (id) => String(id).replace(/[^\w.-]/g, '_'); // ids become file names

export const closedInfo = (log, session) => (session ? readJson(path.join(stateDirs(log).closed, `${safe(session)}.json`)) : null);
export function closeSession(log, { session, target, by, reason }) {
  if (!session) return;
  writeJson(path.join(stateDirs(log).closed, `${safe(session)}.json`), { session, target, by, reason, at: Date.now() });
}
export function listClosed(log) {
  const dir = stateDirs(log).closed;
  return (fs.existsSync(dir) ? fs.readdirSync(dir) : []).map((f) => readJson(path.join(dir, f))).filter(Boolean);
}

// Active pause for an agent, or null. A pause whose `until` has passed (or was reset to 0 by "Resume") is over.
export function pausedInfo(log, target, now = Date.now()) {
  const p = readJson(path.join(stateDirs(log).paused, `${target}.json`));
  return p && p.until > now ? p : null;
}
export function pause(log, { target, reason, ms }) {
  const at = Date.now();
  writeJson(path.join(stateDirs(log).paused, `${target}.json`), { target, reason, at, until: at + ms });
  return at + ms;
}
export const resume = (log, target) => writeJson(path.join(stateDirs(log).paused, `${target}.json`), { target, until: 0, resumedAt: Date.now() });

// Did a failed call fail because a quota / usage / rate limit ran out? Only asked of failed calls, so a
// successful reply that merely talks about rate limits is never mistaken for one.
const LIMIT = /quota|rate[ _-]?limit|usage limit|limit (reached|exceeded)|RESOURCE_EXHAUSTED|too many requests|\b429\b|credit balance|out of credits|exceeded your|billing/i;
export function limitReason(text, json) {
  if (json?.api_error_status === 429) return 'rate limit (HTTP 429)';
  const m = String(text ?? '').match(LIMIT);
  if (!m) return null;
  const line = String(text).split('\n').find((l) => LIMIT.test(l)) ?? m[0];
  return line.trim().slice(0, 200);
}
