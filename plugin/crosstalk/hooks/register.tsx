import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BridgeCall, Closed, Pause, RouteRow, View } from '../types'

const PANE = 'crosstalk'
const TITLE = 'claude ⇄ agy'
const TAIL = 256 * 1024 // only the newest part of the log is read
const AGENTS = ['agy', 'claude'] as const
// Change a tag when that value's fields change: it declines what an earlier version stored.
const calls = atom({ plugin: 'crosstalk', key: 'calls' } as const, [], { shape: 'calls-4' })
const budget = atom({ plugin: 'crosstalk', key: 'budget' } as const, 0, { shape: 'budget-1' })
const view = atom({ plugin: 'crosstalk', key: 'view' } as const, 'all', { shape: 'view-2' })
const routes = atom({ plugin: 'crosstalk', key: 'routes' } as const, [], { shape: 'routes-1' })
const stopping = atom({ plugin: 'crosstalk', key: 'stopping' } as const, [], { shape: 'stopping-1' })
const paused = atom({ plugin: 'crosstalk', key: 'paused' } as const, [], { shape: 'paused-1' })
const closed = atom({ plugin: 'crosstalk', key: 'closed' } as const, [], { shape: 'closed-1' })

// Same pairing as crosstalk/calls.mjs: start, spawned (pid), limit and end lines per call id.
export function pair(text: string): BridgeCall[] {
  const byId = new Map<string, BridgeCall>()
  for (const line of text.split('\n')) {
    let e: any
    try { e = JSON.parse(line) } catch { continue } // also skips a line cut by the tail offset
    if (!e?.id) continue
    const was = byId.get(e.id)
    if (e.event === 'end' || e.event === 'spawned' || e.event === 'limit') {
      if (!was) continue // its start fell outside the tail
      byId.set(e.id, e.event === 'spawned' ? { ...was, pid: e.pid }
        : e.event === 'limit' ? { ...was, reason: e.reason }
        : { ...was, status: e.limit ? 'quota' : e.ok ? 'ok' : 'failed', ms: e.ms, reply: e.reply, session: e.session ?? was.session, usage: e.usage, capped: e.capped })
    } else {
      byId.set(e.id, {
        id: e.id, from: e.from, to: e.to, started: e.ts, depth: e.depth, prompt: e.prompt ?? '',
        task: e.task, model: e.model, effort: e.effort, session: e.session, reason: e.reason,
        status: e.event === 'refused' ? 'refused' : 'running',
      })
    }
  }
  return [...byId.values()].slice(-100)
}

// routes.json -> one row per task with each agent's "model (effort)".
export function routeRows(text: string): RouteRow[] {
  let r: any
  try { r = JSON.parse(text) } catch { return [] }
  const cell = (p: any) => (p?.model ? `${p.model}${p.effort ? ` (${p.effort})` : ''}` : '-')
  return Object.entries(r?.tasks ?? {}).map(([task, about]) => ({
    task: task === r.default ? `${task} *` : task, about: String(about), agy: cell(r.agy?.[task]), claude: cell(r.claude?.[task]),
  }))
}

const oneLine = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString()
const fileId = (id: string) => id.replace(/[^\w.-]/g, '_') // same as state.mjs
const MARK = { ok: '✓', failed: '✗', refused: '⊘', running: '…', quota: '⛔' } as const
const COLOR = { ok: 'success', failed: 'error', refused: 'warning', running: 'suggestion', quota: 'error' } as const
const VIEWS: { id: View; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'running', label: 'Running' }, { id: 'failed', label: 'Failed' },
  { id: 'sessions', label: 'Sessions' }, { id: 'routes', label: 'Routes' },
]

let dir = '' // ~/.crosstalk
let logPath = ''
let seen = -1
let sessionStartedAt = 0 // calls from claude after this belong to this Claude session
let toasted = new Set<string>() // limit stops already announced
let firstPoll = true

async function readJson<T>($: EngineInterface, path: string): Promise<T | null> {
  try { return JSON.parse(await $.fs.read(path)) as T } catch { return null }
}

async function poll($: EngineInterface) {
  const stat = await $.fs.stat(logPath).catch(() => undefined)
  const size = stat?.size ?? 0
  const running = (await read($, calls)).some(c => c.status === 'running')
  if (size !== seen) {
    seen = size
    const offset = Math.max(0, size - TAIL)
    const text = size ? await $.fs.read(logPath, { offset, length: size - offset }).catch(() => '') : ''
    const list = pair(text)
    await update($, calls, () => list)
    await update($, stopping, ids => ids.filter(id => list.some(c => c.id === id && c.status === 'running')))
    // Tell the person once per quota stop, but not about old ones found when the session starts.
    for (const c of list.filter(c => c.status === 'quota' && !toasted.has(c.id))) {
      toasted.add(c.id)
      if (!firstPoll) $.ui.toast(`${c.to} stopped: quota or usage limit ran out. Session closed; ${c.to} is paused. See /crosstalk.`)
    }
  } else if (running) {
    await update($, calls, list => [...list]) // redraw so the elapsed time moves
  }
  firstPoll = false
  const now = await $.clock.now()
  const pauses: Pause[] = []
  for (const a of AGENTS) {
    const p = await readJson<Pause>($, `${dir}/paused/${a}.json`)
    if (p && p.until > now) pauses.push(p)
  }
  await update($, paused, () => pauses)
  const entries = await $.fs.list(`${dir}/closed`).catch(() => [])
  const shut: Closed[] = []
  for (const f of entries) { const k = await readJson<Closed>($, `${dir}/closed/${f.name}`); if (k) shut.push(k) }
  await update($, closed, () => shut)

  const live = (await read($, calls)).filter(c => c.status === 'running')
  $.ui.status(pauses.length ? `⛔ ${pauses.map(p => p.target).join(', ')} paused (quota)`
    : live.length ? `⇄ ${live.map(c => `${c.to}${c.model ? ` (${c.model})` : ''} ${secs(now - c.started)}`).join(', ')}` : undefined)
}

async function loadRoutes($: EngineInterface) {
  const info = await readJson<{ routes?: string }>($, `${dir}/bridge.json`)
  const text = info?.routes ? await $.fs.read(info.routes).catch(() => '') : ''
  await update($, routes, () => routeRows(text))
  let daily = 0
  try { daily = Number(JSON.parse(text).dailyBudgetUsd) || 0 } catch { /* no routes yet */ }
  await update($, budget, () => daily)
}

// Today's totals per agent being called, for the resource meter.
export function meter(list: BridgeCall[], now: number) {
  const day = new Date(now).toDateString()
  const out: Record<string, { calls: number; inTok: number; outTok: number; thinkTok: number; costUsd: number; ms: number }> = {}
  for (const c of list.filter(c => new Date(c.started).toDateString() === day)) {
    const m = (out[c.to] ??= { calls: 0, inTok: 0, outTok: 0, thinkTok: 0, costUsd: 0, ms: 0 })
    m.calls++; m.ms += c.ms ?? 0
    m.inTok += c.usage?.inTok ?? 0; m.outTok += c.usage?.outTok ?? 0; m.thinkTok += c.usage?.thinkTok ?? 0; m.costUsd += c.usage?.costUsd ?? 0
  }
  return out
}
const kTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const bar = (f: number, w = 16) => { const n = Math.round(Math.min(1, Math.max(0, f)) * w); return `${'█'.repeat(n)}${'░'.repeat(w - n)}` }

// Ask the bridge to stop a call: it watches for ~/.crosstalk/cancel/<id> and kills that agent's process tree.
async function stop($: EngineInterface, id: string) {
  await $.fs.write(`${dir}/cancel/${id}`, '')
  await update($, stopping, ids => [...ids, id])
}

async function closeOne($: EngineInterface, session: string, target: string, by: string) {
  const k: Closed = { session, target, by, at: await $.clock.now() }
  await $.fs.write(`${dir}/closed/${fileId(session)}.json`, JSON.stringify(k, null, 2) + '\n')
  await update($, closed, list => [...list.filter(x => x.session !== session), k])
}

// Hides closed sessions from the list; they stay closed (the bridge still refuses to resume them).
async function clearClosed($: EngineInterface) {
  const list = await read($, closed)
  for (const k of list) await $.fs.write(`${dir}/closed/${fileId(k.session)}.json`, JSON.stringify({ ...k, cleared: true }, null, 2) + '\n')
  await update($, closed, l => l.map(k => ({ ...k, cleared: true })))
}

async function resumeAgent($: EngineInterface, target: string) {
  await $.fs.write(`${dir}/paused/${target}.json`, JSON.stringify({ target, until: 0, resumedAt: await $.clock.now() }) + '\n')
  await update($, paused, l => l.filter(p => p.target !== target))
}

// /clear or leaving Claude: stop the agents this Claude session started and close their sessions.
// shortcut: "this session's" = calls from claude since it started; two Claude windows at once can't be told apart.
async function endSession($: EngineInterface, reason: string) {
  const by = reason === 'clear' ? 'closed by /clear' : 'Claude session ended'
  const mine = (await read($, calls)).filter(c => c.from === 'claude' && c.started >= sessionStartedAt)
  for (const c of mine.filter(c => c.status === 'running')) await stop($, c.id)
  const shut = new Set((await read($, closed)).map(k => k.session))
  for (const c of mine) if (c.session && !shut.has(c.session)) { shut.add(c.session); await closeOne($, c.session, c.to, by) }
  return mine.length
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    logPath = (await $.env.get('CROSSTALK_LOG')) ?? `${home}/.crosstalk/calls.jsonl`
    dir = logPath.replace(/[\\/][^\\/]*$/, '')
    sessionStartedAt = await $.clock.now()
    await $.command.register({ name: 'crosstalk', description: 'Show Claude ⇄ agy agent-to-agent calls in a side pane' })
    await poll($)
    await loadRoutes($)
    $.clock.every(1500, () => poll($))
    void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const n = await endSession($, e.reason)
    if (n && e.reason === 'clear') $.ui.toast(`Stopped and closed the agy sessions from before /clear (${n} call${n === 1 ? '' : 's'}).`)
    sessionStartedAt = await $.clock.now() // after /clear the process goes on as a new session
    return next(e)
  })

  on('command.run', { command: 'crosstalk' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'agy bridge map opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, calls)
    const current = await read($, view)
    const asked = await read($, stopping)
    const pauses = await read($, paused)
    const shut = await read($, closed)
    const rows = current === 'routes' ? await read($, routes) : []
    const daily = await read($, budget)
    const now = await $.clock.now()
    const used = meter(list, now)
    const spent = Object.values(used).reduce((t, m) => t + m.costUsd, 0)
    const count = (s: BridgeCall['status']) => list.filter(c => c.status === s).length
    const done = list.filter(c => c.ms != null)
    const avg = done.length ? secs(done.reduce((t, c) => t + (c.ms ?? 0), 0) / done.length) : '-'
    const live = list.filter(c => c.status === 'running')
    const shown = list.filter(c => current === 'all' || (current === 'running' ? c.status === 'running' : c.status !== 'ok' && c.status !== 'running'))
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 24) - 10 - live.length - pauses.length * 2) / 5))
    const how = (c: BridgeCall) => [c.task, c.model, c.effort && `effort ${c.effort}`, c.pid && `pid ${c.pid}`].filter(Boolean).join(' · ')

    // Sessions: every session seen in the log, plus closed ones, minus closed ones the person cleared.
    const closedBy = new Map(shut.map(k => [k.session, k]))
    const sessionList = [...new Map(
      [...list.filter(c => c.session).map(c => [c.session!, { session: c.session!, target: c.to, last: c.started }] as const),
        ...shut.map(k => [k.session, { session: k.session, target: k.target, last: k.at }] as const)],
    ).values()].filter(s => !closedBy.get(s.session)?.cleared).sort((a, b) => b.last - a.last)

    return (
      <Box flexDirection="column">
        {pauses.map(p => (
          <Box flexDirection="column" marginBottom={1}>
            <Text color="error" bold>⛔ {p.target} paused: its quota or usage limit ran out at {hhmm(p.at)}.</Text>
            <Box flexDirection="row" gap={1}>
              <Text wrap="truncate-end" dimColor>Its session was closed. Nothing new starts until {hhmm(p.until)}. {oneLine(p.reason)}</Text>
              <Button key={`resume-${p.target}`} label="Resume now" onPress={() => resumeAgent($, p.target)} />
            </Box>
          </Box>
        ))}

        <Text bold>
          {list.length} calls · <Text color="suggestion">{count('running')} running</Text> ·{' '}
          <Text color="success">{count('ok')} ok</Text> · <Text color="error">{count('failed') + count('quota')} failed</Text> · avg {avg}
        </Text>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Resources today</Text>
          {Object.keys(used).length === 0 && <Text dimColor>No calls today.</Text>}
          {Object.entries(used).map(([to, m]) => (
            <Text wrap="truncate-end">
              <Text bold>{to.padEnd(6)}</Text> {m.calls} call{m.calls === 1 ? '' : 's'} · {kTok(m.inTok)} in · {kTok(m.outTok)} out ·{' '}
              {kTok(m.thinkTok)} thinking{m.costUsd ? ` · $${m.costUsd.toFixed(2)}` : ''} <Text dimColor>· busy {secs(m.ms)}</Text>
            </Text>
          ))}
          {daily > 0 && (
            <Text>
              <Text color={spent >= daily ? 'error' : spent >= daily * 0.8 ? 'warning' : 'success'}>{bar(spent / daily)}</Text>{' '}
              ${spent.toFixed(2)} of ${daily} daily budget{spent >= daily ? ' · used up, new calls refused' : ''}
            </Text>
          )}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Agents running</Text>
          {live.length === 0 && <Text dimColor>None right now.</Text>}
          {live.map(c => (
            <Box flexDirection="row" gap={1}>
              <Text wrap="truncate-end">
                <Text color="suggestion">●</Text> {c.from} → <Text bold>{c.to}</Text>{' '}
                <Text dimColor>{how(c) || 'starting'} · {secs(now - c.started)}</Text>
              </Text>
              {asked.includes(c.id)
                ? <Text color="warning">stopping…</Text>
                : <Button key={`stop-${c.id}`} label="Stop" onPress={() => stop($, c.id)} />}
            </Box>
          ))}
        </Box>

        <Box flexDirection="row" gap={1} marginTop={1}>
          {VIEWS.map(v => (
            <Button key={`view-${v.id}`} label={v.label} variant={v.id === current ? 'primary' : 'secondary'}
              onPress={async () => { if (v.id === 'routes') await loadRoutes($); await update($, view, () => v.id) }} />
          ))}
        </Box>

        {current === 'routes' ? (
          rows.length === 0 ? (
            <Text dimColor>No routes found. Run node sync.mjs in crosstalk once.</Text>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>Calls pick a task; the task picks the model (* = default). Edit routes.json, then press Routes again.</Text>
              {rows.map(r => (
                <Box flexDirection="column" marginTop={1}>
                  <Text bold>{r.task}</Text>
                  <Text wrap="truncate-end"><Text dimColor>agy    </Text>{r.agy}</Text>
                  <Text wrap="truncate-end"><Text dimColor>claude </Text>{r.claude}</Text>
                  <Text dimColor wrap="truncate-end">{r.about}</Text>
                </Box>
              ))}
            </Box>
          )
        ) : current === 'sessions' ? (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" gap={1}>
              <Text dimColor>A closed session is never resumed. Clear only hides closed ones.</Text>
              {shut.some(k => !k.cleared) && <Button key="clear-closed" label="Clear closed" onPress={() => clearClosed($)} />}
            </Box>
            {sessionList.length === 0 && <Text dimColor>No sessions yet.</Text>}
            {sessionList.map(s => {
              const k = closedBy.get(s.session)
              return (
                <Box flexDirection="row" gap={1}>
                  <Text wrap="truncate-end">
                    <Text color={k ? 'error' : 'success'}>{k ? 'closed' : 'open  '}</Text> {s.target} <Text dimColor>{s.session.slice(0, 8)} · {hhmm(s.last)}</Text>
                    {k && <Text dimColor> · {k.by}{k.reason ? `: ${oneLine(k.reason)}` : ''}</Text>}
                  </Text>
                  {!k && <Button key={`close-${s.session}`} label="Close" onPress={() => closeOne($, s.session, s.target, 'closed by you')} />}
                </Box>
              )
            })}
          </Box>
        ) : (
          <Box flexDirection="column">
            {shown.length === 0 && (
              <Text dimColor>
                {list.length === 0 ? 'No agent-to-agent calls yet. Ask Claude to use ask_agy, or agy to use ask_claude.' : `No ${current} calls.`}
              </Text>
            )}
            {shown.slice(-room).reverse().map(c => (
              <Box flexDirection="column" marginTop={1}>
                <Text>
                  <Text color={COLOR[c.status]}>{MARK[c.status]}</Text>{' '}
                  <Text bold>{c.from} → {c.to}</Text>{' '}
                  <Text dimColor>
                    {hhmm(c.started)} · {c.ms != null ? secs(c.ms) : c.status === 'running' ? secs(now - c.started) : '-'}
                    {c.depth ? ` · depth ${c.depth}` : ''}
                  </Text>
                </Text>
                {how(c) !== '' && <Text dimColor wrap="truncate-end">{how(c)}</Text>}
                {c.status === 'quota' && <Text color="error" wrap="truncate-end">quota ran out: {oneLine(c.reason)} · session closed</Text>}
                {c.status === 'refused' && c.reason && <Text color="warning" wrap="truncate-end">refused: {oneLine(c.reason)}</Text>}
                {c.usage && (
                  <Text dimColor wrap="truncate-end">
                    {kTok(c.usage.inTok)} in · {kTok(c.usage.outTok)} out · {kTok(c.usage.thinkTok)} thinking
                    {c.usage.costUsd ? ` · $${c.usage.costUsd.toFixed(3)}` : ''}{c.usage.turns ? ` · ${c.usage.turns} turns` : ''}
                  </Text>
                )}
                {c.capped && <Text color="warning" wrap="truncate-end">stopped at its {c.capped}</Text>}
                <Text wrap="truncate-end"><Text dimColor>ask </Text>{oneLine(c.prompt)}</Text>
                {c.reply != null && c.status !== 'quota' && (
                  <Text wrap="truncate-end" color={c.status === 'failed' ? 'error' : undefined}>
                    <Text dimColor>got </Text>{oneLine(c.reply)}
                  </Text>
                )}
              </Box>
            ))}
          </Box>
        )}
        <Text dimColor>{logPath}</Text>
      </Box>
    )
  })
}
