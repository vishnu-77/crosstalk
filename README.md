# crosstalk

**Let Claude Code and Google's Antigravity CLI (`agy`) talk to each other.**

Claude gets an `ask_agy` tool and agy gets an `ask_claude` tool, so either agent can hand work to the other: a second opinion, a review, or a whole task. One command also copies your Claude Code setup into agy, so both agents follow the same rules. A side pane in Claude Code shows every call as it happens.

- **Two-way MCP bridge.** Small, with no packages to install. Sessions can be continued, and a depth limit stops the agents calling each other forever.
- **Picks a model for each task.** `quick`, `code`, `review`, `research` or `deep` each get their own model, effort level and limits (for example Haiku for quick questions, Opus for reviews).
- **Knows when to stop.** Every call gets a stop rule, plus hard caps on turns, spend and time, and an optional daily budget.
- **Handles quota.** When an agent runs out of quota, its session is closed for good, the agent is paused, and both you and the calling agent are told.
- **Live side pane.** Shows the agents that are running, with a Stop button for each, today's tokens and cost, sessions you can close, and the routing table.
- **Proof it works.** `node health.mjs --live` makes a real call each way and checks the answer.

## Requirements

- Node.js 20.3 or newer
- [Claude Code](https://claude.com/claude-code), signed in (`claude`)
- [Antigravity CLI](https://antigravity.google), signed in (`agy`)

## Quick start

```sh
git clone https://github.com/vishnu-77/crosstalk
cd crosstalk
node sync.mjs --dry   # preview what will be set up
node sync.mjs         # copy your Claude setup into agy and connect both sides
node health.mjs --live  # one real call each way
```

Restart Claude Code to get `ask_agy`, and open a new agy session to get `ask_claude`. Run `node sync.mjs` again whenever your CLAUDE.md, skills, commands or MCP servers change.

**Side pane:** in Claude Code, run:

```
/plugin marketplace add vishnu-77/crosstalk
/plugin install crosstalk@crosstalk
```

Then `/crosstalk` opens the pane.

**Health check at every Claude start:** add this to the `hooks` section of your Claude Code `settings.json`. agy gets its own start-of-session check from `sync.mjs` automatically.

```json
"SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"/path/to/crosstalk/health.mjs\" --claude", "timeout": 20 }] }]
```

## What's in it

| File | What it does |
| --- | --- |
| `bridge-mcp.mjs` | The MCP server. `node bridge-mcp.mjs agy` gives Claude an `ask_agy` tool, and `node bridge-mcp.mjs claude` gives agy an `ask_claude` tool. Each call runs the other agent without its interactive screen and returns its answer plus a session id, which you pass back as `session` to continue the conversation. |
| `sync.mjs` | Copies your Claude Code setup into an agy plugin (`~/.gemini/config/plugins/crosstalk/`): CLAUDE.md becomes a rule, skills and slash commands become agy skills, and MCP servers are converted. It also registers the bridge on both sides. |
| `routes.json` | Task → model, effort and limits for each agent, plus the stop rule and the daily budget. |
| `health.mjs` | Quick check of the setup. `--live` makes a real call in each direction. |
| `calls.mjs` | Terminal view of the call log, the meter and sessions. |
| `state.mjs` | Files for closed sessions and paused agents. |
| `plugin/crosstalk` | The Claude Code side pane. |
| `test.mjs` | Tests that need neither agent installed (`node test.mjs`). |

## Seeing that the agents are talking

Every call through the bridge, whichever agent makes it, is added to `~/.crosstalk/calls.jsonl`: a start line, then an end line with how long it took, whether it worked, and the start of the reply. Calls refused by the depth limit are logged too. When the file passes 5 MB it's moved to `calls.jsonl.1`.

- **Side pane in Claude Code:** the `crosstalk` mod opens a "claude ⇄ agy" pane when a session starts (`/crosstalk` reopens it). It shows totals, then one card per call: direction, ✓/✗/…, time taken, what was asked and what came back. The status line shows `⇄ agy working 12.3s` while a call runs.
- **Terminal (works from the agy side too):** `node calls.mjs` shows the last 10 calls, and `node calls.mjs -f` follows live.

## Proving it works

`node health.mjs --live` makes one real call in each direction over the actual MCP bridge. It passes only if the other agent's reply contains a random code word, which can't be faked or cached, and the call shows up in the log as a start line and an end line. It uses the cheap `quick` route and takes about 15 s.

```
LIVE claude -> agy answered PING-YF7O7F in 13.0s and was logged
LIVE agy -> claude answered PING-MX4POA in 16.0s and was logged
```

## Choosing a model for each task

Both tools take a `task` option: `quick`, `code`, `review`, `research` or `deep`. `routes.json` maps each task to a model and effort level for each agent:

| task | agy | claude |
| --- | --- | --- |
| quick | gemini-3.8-flash-low (low) | haiku (low) |
| code (default) | gemini-3.8-flash-high (medium) | sonnet (medium) |
| review | gemini-3.8-flash-high (high) | opus (high) |
| research | gemini-3.8-flash-medium (medium) | sonnet (medium) |
| deep | gemini-3.8-flash-high (max) | opus (xhigh) |

The file is read on every call, so edits apply straight away. A `model` passed in the call wins over the table. The tool description lists the tasks and their models, so the calling agent can choose. Run `agy models` for agy's model ids.

## Side pane controls

- **Agents running:** each agent the bridge has started, with who called it, its task, model, effort, PID and how long it has been running. Each one has a **Stop** button. The pane writes `~/.crosstalk/cancel/<id>`, and within a second the bridge kills that agent's whole process tree.
- **All / Running / Failed / Routes:** filter the call list, or show the task → model table.
- **Status line:** shows the running agent and its model, for example `⇄ claude (opus) 12.3s`.

## When a quota runs out, and closing sessions

When a call fails because an agent's quota or usage limit ran out, the bridge does four things. It looks for messages such as "usage limit reached", HTTP 429, `RESOURCE_EXHAUSTED` or "quota exceeded", and checks only calls that failed, so a reply that just talks about rate limits doesn't trigger it.

1. **Closes that session for good.** It writes `~/.crosstalk/closed/<session>.json`, and any later call that passes that session id is refused with a message saying why.
2. **Pauses the agent** for `CROSSTALK_PAUSE_MS` (default 30 min), using `~/.crosstalk/paused/<agent>.json`. While paused, new calls are refused at once and nothing is started.
3. **Tells the calling agent** in plain words: "agy stopped: its quota or usage limit ran out … Session X is closed … paused until 15:01 … Tell the user."
4. **Tells you:** the side pane shows a red ⛔ banner with a **Resume now** button, pops up a short note, shows `⛔ agy paused (quota)` in the status line and marks the call ⛔. The check that runs when either agent starts reports the pause too, and in Claude it also tells the model so it can pass it on.

Closing and clearing:

- **Pane → Sessions:** every session the bridge has seen, open or closed (with the reason). **Close** closes one for good. **Clear closed** hides closed sessions from the list, and they stay closed.
- **`/clear` or leaving Claude Code:** the pane stops any agents this Claude session started that are still running, and closes their sessions ("closed by /clear" or "Claude session ended").
- **Terminal:** `node calls.mjs sessions`, `node calls.mjs close <id>`, `node calls.mjs clear`, `node calls.mjs resume <agy|claude>`.

## Speed and cost

- Claude starts lean when agy calls it: no MCP servers and no skills (`--strict-mcp-config --disable-slash-commands`). On this profile that took a call from $0.37 / 15.4 s to $0.07 / 8.5 s. It also means that Claude has no `ask_agy` tool, so it can't loop back. Set `CROSSTALK_LEAN=0` before `node sync.mjs` if the called Claude needs your skills or MCP servers.
- agy is started as it is. Skipping its skills didn't save anything when measured.
- Every call has a timeout (`CROSSTALK_TIMEOUT_MS`, default 15 min). A call the caller cancels, or whose session closes, is stopped too. The whole process tree is killed, so no agent or MCP server is left running.

## Health check at every start

`health.mjs` runs when either agent starts a session. It takes about 1 s and calls no model. It checks four things: both CLIs run, both bridges answer an MCP handshake, both registrations point at this folder, and agy's copy of your CLAUDE.md and skills matches the source.

- Claude Code: a `SessionStart` hook in your profile's `settings.json` shows one status line. The model is told only when something is broken.
- agy: `sync.mjs` writes `hooks.json` into the plugin, so a re-sync keeps the hook. The status goes in as a system message.
- By hand: `node health.mjs` (exits with code 1 on failure).

If it reports STALE, run `node sync.mjs`.

## Permissions

Each agent runs the other in headless mode, and headless mode can't ask you for approval. So by default the agent being called can read and answer, but its tool calls that need approval are denied. To give it more, set these before running `sync.mjs`:

```powershell
# agy, when Claude calls it: allow everything (or pass --settings with a narrower allow list)
$env:CROSSTALK_AGY_ARGS = '["--dangerously-skip-permissions"]'
# Claude, when agy calls it: e.g. allow edits
$env:CROSSTALK_CLAUDE_ARGS = '["--permission-mode","acceptEdits"]'
node sync.mjs
```

Calling the bridge tool itself: interactive sessions ask you the first time. For headless agy runs, add `"mcp(*)"` to `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`. agy 1.5.14 didn't accept any per-server rule spelling I tried, so the only working rule allows every MCP tool.

## Loop guard

Every call raises `CROSSTALK_DEPTH` by one. Past `CROSSTALK_MAX_DEPTH` (default 2), the tool refuses, so the agents can't keep calling each other forever.

## Not synced

Claude hooks and permissions (agy uses different tool names and rule syntax). Claude plugins: run `agy plugin import claude`. Subagents in `agents/`: ask agy to run its `migrate-agent-settings` skill.

## Undo

```powershell
claude mcp remove agy -s user
Remove-Item -Recurse ~/.gemini/config/plugins/crosstalk
```
