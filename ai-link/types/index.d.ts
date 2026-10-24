export type Msg = { at: number; dir: 'in' | 'out'; who: string; text: string }
export type Me = { id: string; name: string }
export type Role = 'solo' | 'host'
export type Task = {
  id: string
  toId: string
  toName: string
  text: string
  status: 'sent' | 'done' | 'failed'
  result?: string
  at: number
}
export type Inbox = { id: string; hostId: string; hostName: string; text: string }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Cat = { name: string; tokens: number }
export type Snap = {
  percent: number
  tokens: number
  window: number
  limits: Limit[]
  usd: number | null
  startedAt: number
  model: string
  cats: Cat[]
  compactAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'ai-link': {
      // session messaging and host mode
      log: Msg[]
      me: Me | null
      role: Role
      tasks: Task[]
      inbox: Inbox[]
      target: string
      // usage pane
      snap: Snap | null
      showTools: boolean
      showWhere: boolean
      title: string
      effort: string
    }
  }
}
