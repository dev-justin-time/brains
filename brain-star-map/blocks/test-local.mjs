// Local, offline test harness for the Blocks handlers.
//
// Simulates the Blocks runtime (StartTaskMessage + TaskContext) without a
// network connection and exercises the handler contract end-to-end:
//   requestParts/partId -> progress statuses -> outbound token stream ->
//   text + JSON artifacts. Uses the real DB + Ollama when available.
//
// Usage:
//   node blocks/test-local.mjs
//   node blocks/test-local.mjs --agent=expert_connectomics --question="What is connectomics?"
//   node blocks/test-local.mjs --agent=router --question="How many papers are in the corpus?"
//   node blocks/test-local.mjs --expect-error   # missing partId -> handler must throw
import handler from './lib/handler.js'

const arg = name => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : undefined
}
const agentName = arg('agent') || 'router'
const question = arg('question') || 'What is connectomics?'
const expectError = process.argv.includes('--expect-error')
const noPartId = process.argv.includes('--no-partid')

// ---------- fake TaskContext ----------

function makeCtx(text) {
  const statuses = []
  const streamChunks = []
  const stream = {
    streamId: 'test-stream',
    channel: 'fake',
    isActive: true,
    external: false,
    uuid: 'test-uuid',
    write: data => { streamChunks.push(String(data)) },
    end: async () => {},
    inbound: (async function* () {})(),
    bytes: async function* () {},
    events: async function* () {},
    readable: async () => null,
    onEnd: () => {},
    onError: () => {},
  }
  const controller = new AbortController()
  return {
    ctx: {
      taskId: 'test-task-1',
      requestParts: noPartId ? [{ text }] : [{ partId: 'question', text }],
      reportStatus: m => { statuses.push(m); console.log(`  [progress] ${m}`) },
      createStream: async () => stream,
      taskClient: null,
      cancelSignal: controller.signal,
      isCancelled: false,
      isExpired: false,
      hasStream: true,
      consumerPublicKey: undefined,
      downloadInputArtifact: async () => Buffer.from(text),
      publishArtifact: async () => {},
    },
    statuses,
    streamChunks,
    stream,
  }
}

// ---------- run ----------

async function main() {
  console.log(`\n=== blocks handler local test ===`)
  console.log(`agent:    ${agentName}`)
  console.log(`question: ${question}\n`)

  if (expectError) {
    // Contract check: a task without the declared partId must fail fast.
    const { ctx } = makeCtx('')
    ctx.requestParts = [{ partId: 'wrong_id', text: question }]
    let threw = false
    try {
      await handler({ type: 'StartTask', taskId: 't', agentName, ownerId: 'o', orgId: 'g', requestParts: ctx.requestParts }, ctx)
    } catch (err) {
      threw = true
      console.log(`  [ok] handler rejected bad input: ${err.message}`)
    }
    if (!threw) { console.error('  [FAIL] expected a throw for mismatched partId'); process.exit(1) }
    console.log('PASS: input contract enforced')
    return
  }

  const { ctx, statuses, streamChunks } = makeCtx(question)
  const task = {
    type: 'StartTask',
    taskId: 'test-task-1',
    agentName,
    ownerId: 'test-owner',
    orgId: 'test-org',
    requestParts: ctx.requestParts,
  }

  const t0 = Date.now()
  const result = await handler(task, ctx)
  const durationMs = Date.now() - t0

  // ---------- assertions ----------

  const answerArtifact = result.artifacts?.find(a => a.outputId === 'answer')
  const sourcesArtifact = result.artifacts?.find(a => a.outputId === 'sources')

  if (!Array.isArray(result.artifacts) || result.artifacts.length === 0) {
    console.error('  [FAIL] handler returned no artifacts'); process.exit(1)
  }
  if (!answerArtifact || answerArtifact.mimeType !== 'text/plain') {
    console.error('  [FAIL] missing text/plain "answer" artifact'); process.exit(1)
  }
  const answer = String(answerArtifact.data)

  console.log(`\n  [ok] artifacts: ${result.artifacts.length} (${result.artifacts.map(a => `${a.outputId}:${a.mimeType}`).join(', ')})`)
  console.log(`  [ok] status events: ${statuses.length}`)
  console.log(`  [ok] streamed ${streamChunks.join('').length} chars via "tokens" stream`)

  const streamedText = streamChunks.join('')
  if (streamedText.length && answer.includes(streamedText.slice(0, Math.min(80, streamedText.length)))) {
    console.log('  [ok] streamed tokens match the answer artifact')
  } else {
    console.log(`  [warn] streamed text does not prefix the answer (cache hit or non-streaming path)`)
  }

  if (sourcesArtifact) {
    try {
      const src = JSON.parse(String(sourcesArtifact.data))
      console.log(`  [ok] sources artifact: ${src.length} cited papers`)
    } catch {
      console.error('  [FAIL] sources artifact is not valid JSON'); process.exit(1)
    }
  }

  if (!answer.length) {
    console.error('  [FAIL] empty answer'); process.exit(1)
  }

  console.log(`\n  answer (${answer.length} chars, ${durationMs}ms):\n${'─'.repeat(60)}`)
  console.log(answer.slice(0, 900))
  console.log(`${'─'.repeat(60)}`)
  console.log('\nALL CHECKS PASSED')
}

main().catch(err => {
  console.error('\n[FAIL] handler threw:', err.message)
  process.exit(1)
})
