// One agent-to-agent call, paired from the lines crosstalk writes to ~/.crosstalk/calls.jsonl.
export type BridgeCall = {
  id: string
  from: string
  to: string
  status: 'running' | 'ok' | 'failed' | 'refused' | 'quota'
  started: number
  ms?: number
  depth?: number
  task?: string
  model?: string
  effort?: string
  pid?: number
  session?: string
  reason?: string // why it was refused, or why the quota stop happened
  usage?: Usage
  capped?: string // "turn limit (3)" when a task limit stopped the agent
  prompt: string
  reply?: string
}

// Tokens, cost and turns of one call, as the bridge logs them.
export type Usage = { inTok: number; outTok: number; thinkTok: number; costUsd: number; turns: number }

// What the pane lists: every call, running, failed, the sessions, or the task -> model routing table.
export type View = 'all' | 'running' | 'failed' | 'sessions' | 'routes'

// One row of routes.json: which model and effort a task gets for each agent.
export type RouteRow = { task: string; about: string; agy: string; claude: string }

// ~/.crosstalk/paused/<agent>.json while active: calls to that agent are refused until `until`.
export type Pause = { target: string; reason: string; at: number; until: number }

// ~/.crosstalk/closed/<session>.json: a session the bridge will never resume.
export type Closed = { session: string; target: string; by: string; reason?: string; at: number; cleared?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'crosstalk': {
      calls: Shaped<BridgeCall[]>
      view: Shaped<View>
      routes: Shaped<RouteRow[]>
      stopping: Shaped<string[]>
      paused: Shaped<Pause[]>
      closed: Shaped<Closed[]>
      budget: Shaped<number> // routes.json dailyBudgetUsd; 0 = none
    }
  }
}
