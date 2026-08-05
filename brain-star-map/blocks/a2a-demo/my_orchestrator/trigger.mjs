// Consumer-side trigger for the live A2A demo: sends one task to the running
// my_orchestrator agent and prints the merged artifact.
// Usage: node blocks/a2a-demo/my_orchestrator/trigger.mjs
// Requires BLOCKS_API_KEY in .env (created by `blocks login --write-env`).
import 'dotenv/config'
import { TaskClient } from '@blocks-network/sdk'

const BASE_URL = process.env.BLOCKS_BASE_URL || 'https://app.blocks.ai'

if (!process.env.BLOCKS_API_KEY) {
  console.error('Missing BLOCKS_API_KEY — run `blocks login --write-env` first.')
  process.exit(1)
}

console.log('Calling my_orchestrator (A2A demo)...\n')

const client = await TaskClient.create({
  billingMode: 'free',
  apiKey: process.env.BLOCKS_API_KEY,
  baseUrl: BASE_URL,
})

const session = await client.sendMessage({
  agentName: 'my_orchestrator',
  requestParts: [{ partId: 'request', text: 'Run the demo' }],
})

session.onEvent(evt => {
  if (evt.type === 'progress') {
    const msg = evt.message ?? evt.state ?? ''
    if (msg) console.log(`[progress] ${msg}`)
  } else if (evt.type === 'artifact') {
    console.log(`[artifact] ${evt.outputId ?? '?'}`)
  }
})

const terminal = await session.waitForTerminal(120_000)
console.log(`[terminal] state=${terminal.state}${terminal.reason ? ` reason=${terminal.reason}` : ''}`)

for (const ref of session.listArtifacts()) {
  try {
    const d = await session.downloadArtifact(ref)
    console.log(`\n--- ${ref.fileName ?? ref.outputId ?? 'artifact'} ---`)
    console.log(new TextDecoder().decode(d.data))
  } catch (err) {
    console.log(`[download failed] ${err.message}`)
  }
}

session.close()
client.destroy()
process.exit(terminal.state === 'completed' ? 0 : 1)
