// Call a published Blocks agent over the real network (consumer side).
// Submits a request task, prints progress events + streamed tokens as they
// arrive, then downloads and prints the returned artifacts and terminal state.
//
// Usage:  node scripts/call-blocks-agent.mjs <agentName> "<question>"
// Requires BLOCKS_API_KEY in .env (created by `blocks login --write-env`).
import 'dotenv/config'
import { TaskClient } from '@blocks-network/sdk'

const BASE_URL = process.env.BLOCKS_BASE_URL || 'https://app.blocks.ai'
const agentName = process.argv[2] || 'router'
const question = process.argv[3] || 'What is connectomics?'
// Optional --partId override for agents whose input id isn't "question"
// (e.g. `--partId topic` for ada_harvest / the pipe feeds).
let partId = 'question'
const pi = process.argv.indexOf('--partId')
if (pi !== -1 && process.argv[pi + 1]) partId = process.argv[pi + 1]
else {
  const eq = process.argv.find(a => a.startsWith('--partId='))
  if (eq) partId = eq.split('=')[1]
}

if (!process.env.BLOCKS_API_KEY) {
  console.error('Missing BLOCKS_API_KEY — run `blocks login --write-env` first.')
  process.exit(1)
}

console.log(`Calling "${agentName}" with: ${question}\n`)

const client = await TaskClient.create({
  billingMode: 'free',
  apiKey: process.env.BLOCKS_API_KEY,
  baseUrl: BASE_URL,
})

const session = await client.sendMessage({
  agentName,
  requestParts: [{ partId, text: question }],
  stream: true, // request live token streaming
  // Pass a stable idempotencyKey only when retrying a specific submission.
})

// Progress / lifecycle events (types: progress, artifact, terminal, ...)
session.onEvent(evt => {
  if (evt.type === 'progress') {
    const msg = evt.message ?? evt.state ?? ''
    if (msg) console.log(`[progress] ${msg}`)
  } else if (evt.type === 'artifact') {
    console.log(`[artifact] ${evt.outputId ?? '?'} (${(evt.artifactRef?.sizeBytes ?? '?')} bytes)`)
  } else if (evt.type !== 'terminal') {
    console.log(`[event] ${evt.type}`)
  }
})

// Live token stream (the agent's outbound "_default" bytes stream)
session.onStream(ref => {
  ;(async () => {
    try {
      const stream = await ref.open()
      for await (const chunk of stream.bytes()) {
        process.stdout.write(new TextDecoder().decode(chunk))
      }
    } catch (err) {
      console.log(`[stream note] ${err.message}`)
    }
  })()
})

const terminal = await session.waitForTerminal(180_000)
console.log(`\n[terminal] state=${terminal.state}${terminal.reason ? ` reason=${terminal.reason}` : ''}`)

const artifacts = session.listArtifacts()
console.log(`[artifacts] ${artifacts.length} returned`)
for (const ref of artifacts) {
  try {
    const d = await session.downloadArtifact(ref)
    const text = new TextDecoder().decode(d.data)
    console.log(`\n--- ${ref.fileName ?? ref.outputId ?? 'artifact'} (${text.length} chars) ---`)
    console.log(text.slice(0, 1200))
  } catch (err) {
    console.log(`[download failed] ${err.message}`)
  }
}

session.close()
client.destroy()
process.exit(terminal.state === 'completed' ? 0 : 1)
