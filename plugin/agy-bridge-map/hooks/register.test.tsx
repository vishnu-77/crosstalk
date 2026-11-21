import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'agy-bridge-map',
  component: 'Pane',
  requestId: 'agy-bridge-map',
  props: { title: 'claude ⇄ agy', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const LOG = [
  '{"ts":1000,"id":"a","event":"start","from":"claude","to":"agy","depth":0,"task":"quick","model":"gemini-3.8-flash-low","effort":"low","prompt":"Reply with exactly: hello from agy"}',
  '{"ts":1100,"id":"a","event":"spawned","pid":111}',
  '{"ts":3500,"id":"a","event":"end","from":"claude","to":"agy","ms":2500,"ok":true,"reply":"hello from agy"}',
  '{"ts":4000,"id":"b","event":"start","from":"agy","to":"claude","depth":1,"task":"review","model":"opus","effort":"high","prompt":"review this diff"}',
  '{"ts":4100,"id":"b","event":"spawned","pid":4242}',
].join('\n') + '\n'

const ROUTES = JSON.stringify({
  tasks: { quick: 'Short questions.', review: 'Review code.' }, default: 'quick',
  agy: { quick: { model: 'gemini-3.8-flash-low', effort: 'low' }, review: { model: 'gemini-3.8-flash-high', effort: 'high' } },
  claude: { quick: { model: 'haiku', effort: 'low' }, review: { model: 'opus', effort: 'high' } },
})

const writes: string[] = []

// Stands in for the engine: the log, any state files (path suffix -> text), the clock.
function engine(on: any, { log = LOG, files = {} as Record<string, string>, now = 5000 } = {}) {
  const all: Record<string, string> = { 'bridge.json': '{"routes":"D:/agy-bridge/routes.json"}', 'routes.json': ROUTES, ...files }
  on('command.register', () => ({ value: { command: 'agy-map' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.end', (_: unknown, e: any) => ({ sessionId: e.sessionId }))
  on('env.get', (_: unknown, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: log.length, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_: unknown, e: any) => {
    const p = String(e.path).replace(/\\/g, '/')
    if (p.endsWith('calls.jsonl')) return { value: log }
    const hit = Object.keys(all).find(k => p.endsWith(k))
    if (hit) return { value: all[hit] }
    throw new Error('ENOENT')
  })
  on('fs.list', () => ({ value: Object.keys(all).filter(k => k.startsWith('closed/')).map(k => ({ name: k.slice(7), kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }))
  // Writes land in `all` like a disk, so a poll after a press reads what the press wrote.
  on('fs.write', (_: unknown, e: any) => {
    const p = String(e.path).replace(/\\/g, '/')
    writes.push(`${p} ${e.text}`)
    const m = p.match(/(closed|paused|cancel)\/[^/]+$/)
    if (m) all[m[0]] = e.text
    return { value: undefined }
  })
  on('clock.now', () => ({ value: now }))
  on('clock.every', () => ({ value: {} }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
}

test('the pane shows calls with task, model and pid, and the running agent', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /calls ·/ }))?.text).toContain('2 calls')
  expect((await ui.find({ type: 'Text', text: /claude → agy/ }))?.text).toContain('2.5s')
  expect((await ui.find({ type: 'Text', text: /^quick · gemini/ }))?.text).toBe('quick · gemini-3.8-flash-low · effort low · pid 111')
  expect((await ui.find({ type: 'Text', text: /^got / }))?.text).toBe('got hello from agy')
  // The running agent is listed with its model, pid and elapsed time.
  expect((await ui.find({ type: 'Text', text: /^● agy → claude/ }))?.text).toContain('review · opus · effort high · pid 4242 · 1.0s')
  await ui.unmount()
})

test('Stop asks the bridge to kill that agent', async ($, on) => {
  engine(on)
  writes.length = 0
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'stop-b' })
  expect(writes.some(w => w.startsWith('C:/Users/me/.agy-bridge/cancel/b'))).toBe(true)
  expect((await ui.find({ type: 'Text', text: /stopping/ }))?.text).toBe('stopping…')
  await ui.unmount()
})

test('the filter buttons narrow the list, and Routes shows task -> model', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'view-failed' })
  expect((await ui.find({ type: 'Text', text: /No failed calls/ }))?.text).toBe('No failed calls.')

  await ui.press({ key: 'view-routes' })
  expect((await ui.find({ type: 'Text', text: /^quick \*/ }))?.text).toBe('quick *')
  expect((await ui.find({ type: 'Text', text: /^claude opus/ }))?.text).toBe('claude opus (high)')
  await ui.unmount()
})

// A quota stop: agy's call c ran out of quota, its session s-c is closed and agy is paused until 9000.
const QLOG = LOG +
  '{"ts":4200,"id":"c","event":"start","from":"claude","to":"agy","task":"code","model":"gemini-3.8-flash-high","prompt":"build it","session":"s-c"}\n' +
  '{"ts":4300,"id":"c","event":"limit","to":"agy","session":"s-c","reason":"RESOURCE_EXHAUSTED: quota exceeded","until":9000}\n' +
  '{"ts":4301,"id":"c","event":"end","from":"claude","to":"agy","ms":100,"ok":false,"limit":true,"session":"s-c","reply":"agy stopped"}\n' +
  '{"ts":4400,"id":"d","event":"start","from":"claude","to":"agy","task":"quick","prompt":"hi"}\n' +
  '{"ts":4401,"id":"d","event":"end","from":"claude","to":"agy","ms":900,"ok":true,"session":"s-d","reply":"hello"}\n'
const PAUSE = '{"target":"agy","reason":"RESOURCE_EXHAUSTED: quota exceeded","at":4300,"until":9000}'
const CLOSED_C = '{"session":"s-c","target":"agy","by":"quota","reason":"RESOURCE_EXHAUSTED: quota exceeded","at":4300}'

const quotaEngine = (on: any, files: Record<string, string>, now = 5000) => engine(on, { log: QLOG, files, now })

test('a quota stop shows a paused banner, a closed session and a Resume button', async ($, on) => {
  writes.length = 0
  quotaEngine(on, { 'paused/agy.json': PAUSE, 'closed/s-c.json': CLOSED_C })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^⛔ agy paused/ }))?.text).toContain('quota or usage limit ran out')
  expect((await ui.find({ type: 'Text', text: /^quota ran out/ }))?.text).toBe('quota ran out: RESOURCE_EXHAUSTED: quota exceeded · session closed')

  await ui.press({ key: 'resume-agy' })
  expect(writes.some(w => w.includes('paused/agy.json') && w.includes('"until":0'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^⛔ agy paused/ })).toBeUndefined()
  await ui.unmount()
})

test('Sessions lists open and closed sessions; Close and Clear closed write the state files', async ($, on) => {
  writes.length = 0
  quotaEngine(on, { 'closed/s-c.json': CLOSED_C })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'view-sessions' })
  expect((await ui.find({ type: 'Text', text: /^closed agy s-c/ }))?.text).toContain('quota')
  expect((await ui.find({ type: 'Text', text: /^open {3}agy s-d/ }))).toBeDefined()

  await ui.press({ key: 'close-s-d' })
  expect(writes.some(w => w.includes('closed/s-d.json') && w.includes('closed by you'))).toBe(true)

  await ui.press({ key: 'clear-closed' })
  expect(writes.filter(w => w.includes('"cleared": true')).length).toBe(2)
  expect((await ui.find({ type: 'Text', text: /No sessions yet/ }))?.text).toBe('No sessions yet.')
  await ui.unmount()
})

test('/clear stops the running agents from this Claude session and closes their sessions', async ($, on) => {
  writes.length = 0
  quotaEngine(on, {}, 0) // the session started before every call in the log
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.end({ reason: 'clear', sessionId: 'x', resume: {} as any })

  // call b is agy -> claude, so it is not this Claude session's; d and c are claude -> agy.
  expect(writes.some(w => w.includes('cancel/b'))).toBe(false)
  expect(writes.some(w => w.includes('closed/s-d.json') && w.includes('closed by /clear'))).toBe(true)
})

test('the resource meter totals today per agent and fills the budget bar', async ($, on) => {
  const day = new Date(5000).toDateString() === new Date(100000).toDateString() // the log's times are all on one day
  expect(day).toBe(true)
  const MLOG = LOG.replace('"reply":"hello from agy"}', '"reply":"hello from agy","usage":{"inTok":9630,"outTok":25,"thinkTok":24,"costUsd":0,"turns":1}}') +
    '{"ts":4500,"id":"e","event":"start","from":"agy","to":"claude","task":"quick","prompt":"q"}\n' +
    '{"ts":4600,"id":"e","event":"end","from":"agy","to":"claude","ms":800,"ok":false,"capped":"turn limit (3)","usage":{"inTok":2000,"outTok":100,"thinkTok":0,"costUsd":4.5,"turns":3},"reply":"x"}\n'
  engine(on, { log: MLOG, files: { 'routes.json': JSON.stringify({ ...JSON.parse(ROUTES), dailyBudgetUsd: 5 }) } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^agy {4}1 call/ }))?.text).toContain('9.6k in · 25 out · 24 thinking')
  expect((await ui.find({ type: 'Text', text: /^claude 2 calls/ }))?.text).toContain('$4.50')
  expect((await ui.find({ type: 'Text', text: /daily budget/ }))?.text).toBe('██████████████░░ $4.50 of $5 daily budget')
  expect((await ui.find({ type: 'Text', text: /^stopped at its/ }))?.text).toBe('stopped at its turn limit (3)')
  await ui.unmount()
})

test('with no log yet the pane says how to start', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No agent-to-agent calls/ }))?.text).toContain('ask_agy')
  await ui.unmount()
})
