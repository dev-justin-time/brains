// Pull real task usage per agent from the Blocks network.
// Usage: node scripts/agent-usage-stats.mjs [agentName] [limit]
// Requires BLOCKS_API_KEY in .env (created by `blocks login --write-env`).
import 'dotenv/config'
import { TaskClient } from '@blocks-network/sdk'

const agentFilter = process.argv[2]
const LIMIT = parseInt(process.argv[3] || '200', 10)

if (!process.env.BLOCKS_API_KEY) {
  console.error('Missing BLOCKS_API_KEY — run `blocks login --write-env` first.')
  process.exit(1)
}

const client = new TaskClient({ apiKey: process.env.BLOCKS_API_KEY, billingMode: 'free' })

const byAgent = new Map()
let total = 0
let cursor
do {
  const params = { limit: 100, ...(cursor ? { cursor } : {}) }
  const res = await client.listTasks(params)
  for (const t of res.tasks ?? []) {
    total++
    const name = t.agentName || '?'
    if (!byAgent.has(name)) byAgent.set(name, { count: 0, states: {} })
    const entry = byAgent.get(name)
    entry.count++
    const st = t.state || '?'
    entry.states[st] = (entry.states[st] || 0) + 1
  }
  cursor = res.next
} while (cursor && total < LIMIT)

console.log(`total tasks fetched: ${total}`)
if (agentFilter) {
  const e = byAgent.get(agentFilter)
  console.log(agentFilter, e ? JSON.stringify(e) : '(none)')
} else {
  for (const [name, e] of [...byAgent.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`${name.padEnd(22)} ${String(e.count).padStart(5)}  states=${JSON.stringify(e.states)}`)
  }
}
process.exit(0)
