// Call a pipe-streaming agent over the real network (consumer side).
// Opens a pipe task with a caller-set duration, consumes the agent's live
// events stream as it arrives, then downloads the terminal summary artifact.
//
// Usage:  node scripts/call-pipe-agent.mjs <agentName> "<topic>" [durationMinutes]
// Example: node scripts/call-pipe-agent.mjs paper_feed "EEG motor imagery" 1
// Requires BLOCKS_API_KEY in .env (created by `blocks login --write-env`).
import 'dotenv/config'
import { TaskClient } from '@blocks-network/sdk'

const BASE_URL = process.env.BLOCKS_BASE_URL || 'https://app.blocks.ai'
const agentName = process.argv[2] || 'paper_feed'
const topic = process.argv[3] || 'EEG'
const durationMin = parseInt(process.argv[4] || '1', 10)
const consumeSec = parseInt(process.argv[5] || (durationMin * 60), 10)

if (!process.env.BLOCKS_API_KEY) {
  console.error('Missing BLOCKS_API_KEY — run `blocks login --write-env` first.')
  process.exit(1)
}

console.log(`Opening pipe task on "${agentName}" (topic: "${topic}", duration: ${durationMin} min)\n`)

const client = await TaskClient.create({
  billingMode: 'paid',
  apiKey: process.env.BLOCKS_API_KEY,
  baseUrl: BASE_URL,
})

const session = await client.sendMessage({
  agentName,
  taskKind: 'pipe',
  duration: durationMin,
  requestParts: [{ partId: 'topic', text: topic }],
})

session.onEvent(evt => {
  if (evt.type === 'progress') {
    const msg = evt.message ?? evt.state ?? ''
    if (msg) console.log(`[progress] ${msg}`)
  } else if (evt.type === 'artifact') {
    console.log(`[artifact] ${evt.outputId ?? '?'} (${evt.artifactRef?.sizeBytes ?? '?'} bytes)`)
  } else if (evt.type !== 'terminal') {
    console.log(`[event] ${evt.type}`)
  }
})

// Consume the live events stream for `consumeSec` seconds.
const streamRef = await session.waitForStream()
const stream = streamRef.open()
const seen = []
const deadline = Date.now() + consumeSec * 1000

console.log(`[stream] consuming events for ${consumeSec}s…`)
try {
  for await (const ev of stream.events()) {
    seen.push(ev)
    const line = ev.type === 'paper'
      ? `[paper] ${ev.year} — ${(ev.title || '').slice(0, 70)} ${ev.url || ''}`
      : JSON.stringify(ev)
    console.log(line)
    if (Date.now() > deadline) break
  }
} catch (err) {
  console.log(`[stream note] ${err.message}`)
}

console.log(`\n[stream] received ${seen.length} event(s) in ${consumeSec}s`)

// Gracefully end the session: cancel the pipe (closes the stream on the agent
// side) and read the summary artifact.
try {
  await session.cancel?.()
} catch (_) { /* pipe may have ended on its own */ }
try {
  const terminal = await session.waitForTerminal(30_000)
  console.log(`[terminal] state=${terminal.state}`)
} catch (err) {
  console.log(`[terminal note] ${err.message}`)
}

const artifacts = session.listArtifacts()
console.log(`[artifacts] ${artifacts.length} returned`)
for (const ref of artifacts) {
  try {
    const d = await session.downloadArtifact(ref)
    const text = new TextDecoder().decode(d.data)
    console.log(`\n--- ${ref.fileName ?? ref.outputId ?? 'artifact'} (${text.length} chars) ---`)
    console.log(text)
  } catch (err) {
    console.log(`[download failed] ${err.message}`)
  }
}

session.close()
client.destroy()
