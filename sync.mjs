#!/usr/bin/env node
// Mirror this Claude Code profile into an Antigravity CLI (agy) plugin, and wire the two agents to each other.
//   node sync.mjs            sync + register bridges
//   node sync.mjs --dry      show what would happen, write nothing
// Re-run after you change CLAUDE.md, skills, commands or MCP servers. Claude's own files are never modified.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS } from './bridge-mcp.mjs';

const DRY = process.argv.includes('--dry');
const NAME = 'crosstalk';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, 'bridge-mcp.mjs');
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PLUGIN = path.join(os.homedir(), '.gemini', 'config', 'plugins', NAME);
const RULE_CAP = 24 * 1024; // agy's per-rule-file limit
const log = (...a) => console.log(...a);
const skipped = [];

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const write = (rel, data) => {
  const p = path.join(PLUGIN, rel);
  if (DRY) return log(`  would write ${rel}`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
};
const frontmatterName = (md) => md.match(/^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+)/m)?.[1]?.trim();

// Remove only our own plugin folder. Links are unlinked, never followed, so linked skill repos stay intact.
function clearPlugin() {
  if (!fs.existsSync(PLUGIN)) return;
  if (readJson(path.join(PLUGIN, 'plugin.json'))?.name !== NAME) throw new Error(`${PLUGIN} exists but is not ours; refusing to touch it`);
  if (DRY) return log('  would clear old plugin folder');
  const skills = path.join(PLUGIN, 'skills');
  for (const e of fs.existsSync(skills) ? fs.readdirSync(skills) : []) {
    const p = path.join(skills, e);
    if (fs.lstatSync(p).isSymbolicLink()) { try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); } }
  }
  fs.rmSync(PLUGIN, { recursive: true, force: true });
}

// 1. CLAUDE.md -> always-on rule
function syncRules() {
  const src = path.join(CLAUDE_DIR, 'CLAUDE.md');
  if (!fs.existsSync(src)) return skipped.push('CLAUDE.md: not found');
  const body = fs.readFileSync(src, 'utf8');
  const rule = `---\ntrigger: always_on\n---\n\n<!-- Synced from ${src} by crosstalk. Edit the source, then re-run sync. -->\n\n${body}`;
  if (Buffer.byteLength(rule) > RULE_CAP) return skipped.push(`CLAUDE.md: ${Buffer.byteLength(rule)} bytes is over agy's 24 KB rule limit, not synced`);
  write('rules/claude.md', rule);
  log('  rule: CLAUDE.md');
}

// 2. skills/* -> copied; commands/*.md -> skills
function syncSkills() {
  const dir = path.join(CLAUDE_DIR, 'skills');
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const src = path.join(dir, name);
    const md = path.join(src, 'SKILL.md');
    if (name.startsWith('.') || !fs.existsSync(md)) continue;
    const fm = frontmatterName(fs.readFileSync(md, 'utf8'));
    if (fm !== name) { skipped.push(`skill ${name}: frontmatter name is "${fm ?? 'missing'}", agy needs it to equal the folder name`); continue; }
    if (DRY) { log(`  would copy skill ${name}`); continue; }
    // agy ignores symlinked/junctioned skill folders (checked on 1.5.14), so copy; re-run sync after editing a skill.
    fs.cpSync(fs.realpathSync(src), path.join(PLUGIN, 'skills', name), { recursive: true, filter: (p) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(p) });
    log(`  skill: ${name}`);
  }
  const cmds = path.join(CLAUDE_DIR, 'commands');
  for (const f of fs.existsSync(cmds) ? fs.readdirSync(cmds).filter((f) => f.endsWith('.md')) : []) {
    const name = path.basename(f, '.md').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    let body = fs.readFileSync(path.join(cmds, f), 'utf8');
    const desc = body.match(/^description:\s*(.+)$/m)?.[1] ?? body.replace(/^---[\s\S]*?---/, '').trim().split('\n')[0];
    body = body.replace(/^---[\s\S]*?---\s*/, '').replace(/\$ARGUMENTS|\$\d/g, '(apply this to what the user asked for)');
    write(`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${JSON.stringify(desc || name)}\n---\n\n${body}`);
    log(`  skill: ${name} (from command ${f})`);
  }
}

// 3. Claude MCP servers -> agy schema, plus the bridge that lets agy ask Claude
function syncMcp() {
  const cfg = readJson(path.join(CLAUDE_DIR, '.claude.json')) ?? readJson(path.join(os.homedir(), '.claude.json')) ?? {};
  const out = {};
  for (const [name, s] of Object.entries(cfg.mcpServers ?? {})) {
    if (name === 'agy') continue; // our own bridge; agy calling itself makes no sense
    if (s.type === 'sse' || /\/sse\/?$/.test(s.url ?? '')) { skipped.push(`mcp ${name}: legacy SSE, agy needs Streamable HTTP (wrap with "npx -y mcp-remote <url>")`); continue; }
    if (JSON.stringify(s).includes('${')) { skipped.push(`mcp ${name}: uses \${VAR} placeholders, which agy plugins don't expand; add it by hand with "agy mcp add"`); continue; }
    const keep = Object.fromEntries(['command', 'args', 'env', 'cwd', 'url', 'headers'].filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
    out[name] = keep;
    log(`  mcp: ${name}`);
  }
  out.claude = { command: process.execPath, args: [BRIDGE, 'claude'], ...(process.env.CROSSTALK_CLAUDE_ARGS && { env: { CROSSTALK_CLAUDE_ARGS: process.env.CROSSTALK_CLAUDE_ARGS } }) };
  log('  mcp: claude (bridge: agy -> Claude Code)');
  write('mcp_config.json', { mcpServers: out });
}

// 4. Register the bridge in Claude Code (user scope) so Claude can ask agy.
function registerInClaude() {
  const bin = TARGETS.claude.bin();
  if (DRY) return log('  would run: claude mcp add -s user agy -- node bridge-mcp.mjs agy');
  try { execFileSync(bin, ['mcp', 'remove', 'agy', '-s', 'user'], { stdio: 'ignore' }); } catch { /* not registered yet */ }
  const env = process.env.CROSSTALK_AGY_ARGS ? ['-e', `CROSSTALK_AGY_ARGS=${process.env.CROSSTALK_AGY_ARGS}`] : [];
  execFileSync(bin, ['mcp', 'add', '-s', 'user', ...env, 'agy', '--', process.execPath, BRIDGE, 'agy'], { stdio: 'inherit' });
}

log(`Claude profile: ${CLAUDE_DIR}\nagy plugin:     ${PLUGIN}${DRY ? '  (dry run)' : ''}\n`);
clearPlugin();
write('plugin.json', { name: NAME, displayName: 'Claude Code sync', version: '1.0.0', description: 'CLAUDE.md, skills, commands and MCP servers mirrored from Claude Code, plus an ask_claude bridge.' });
syncRules();
syncSkills();
syncMcp();
// Health check at every agy session start (Claude's side is a SessionStart hook in its settings.json).
write('hooks.json', { 'crosstalk-health': { SessionStart: [{ type: 'command', command: `"${process.execPath}" "${path.join(HERE, 'health.mjs')}" --agy`, timeout: 20 }] } });
log('  hook: health check on agy session start');
registerInClaude();
// Tell the side pane where this bridge lives, so it can show routes.json.
if (!DRY) {
  const info = path.join(os.homedir(), '.crosstalk', 'bridge.json');
  fs.mkdirSync(path.dirname(info), { recursive: true });
  fs.writeFileSync(info, JSON.stringify({ dir: HERE, routes: path.join(HERE, 'routes.json') }, null, 2) + '\n');
}
log(`\nNot synced (no agy equivalent): Claude hooks, permissions, and plugins. For plugins run "agy plugin import claude".`);
if (fs.existsSync(path.join(CLAUDE_DIR, 'agents')) && fs.readdirSync(path.join(CLAUDE_DIR, 'agents')).length) skipped.push('agents/: subagents not converted yet; ask agy to run its migrate-agent-settings skill');
for (const s of skipped) log(`  skipped ${s}`);
log(DRY ? '\nDry run done.' : '\nDone. Start a new agy session to load it; restart Claude Code to get the ask_agy tool.');
