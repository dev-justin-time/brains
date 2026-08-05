// Offline A2A (agent-to-agent) contract test harness.
//
// Proves the A2A patterns from the Blocks guide WITHOUT the network, using a
// mocked ctx.taskClient whose fake sessions emit the same event shapes the SDK
// does (artifact -> terminal):
//   1. orchestrator happy path  — parallel fan-out, merged artifacts, no ownerId
//   2. partial failure          — one specialist fails, orchestration still completes
//   3. sub-task timeout         — a silent specialist yields a 'timeout' status
//   4. pickSpecialists          — offline topic routing returns real expert names
//   5. echo/adder handlers      — the reference demo handlers behave per the guide
//   6. demo orchestrator        — my_orchestrator merges echo + adder results
//
// Usage: node blocks/test-a2a.mjs
import handler from './lib/handler.js'
import { runOrchestrator, pickSpecialists } from './lib/a2a.js'
import echoHandler from './a2a-demo/my_echo/handler.js'
import adderHandler from './a2a-demo/my_adder/handler.js'
import demoOrchestrator from './a2a-demo/my_orchestrator/handler.js'

let failures = 0
const ok = (cond, label) => {
  if (cond) { console.log(`  [ok] ${label}`) } else { failures++; console.error(`  [FAIL] ${label}`) }
}

const b64 = s => Buffer.from(typeof s === 'string' ? s : JSON.stringify(s)).toString('base64')

// A fake TaskSession that fires artifact events then a terminal event (or stays
// silent for timeout tests), matching the real event shapes.
function fakeSession(spec) {
  const cbs = { artifact: [], terminal: [] }
  const session = {
    closed: false,
    onArtifact: cb => { cbs.artifact.push(cb); return () => {} },
    onTerminal: cb => { cbs.terminal.push(cb); return () => {} },
    close: () => { session.closed = true },
  }
  setTimeout(() => {
    for (const a of spec.artifacts || []) {
      cbs.artifact.forEach(cb => cb({
        type: 'artifact', taskId: 't', outputId: a.outputId,
        artifactRef: { kind: 'inline', mimeType: a.mimeType, size: 1, data: b64(a.data) },
      }))
    }
    if (!spec.neverTerminal) {
      cbs.terminal.forEach(cb => cb({ type: 'terminal', taskId: 't', state: spec.terminal || 'completed', reason: spec.reason }))
    }
  }, spec.delayMs ?? 5)
  return session
}

// A fake TaskClient that records sendMessage params and scripts per-agent outcomes.
function fakeTaskClient(script, captured) {
  return {
    sendMessage: async params => {
      captured.push(params)
      const spec = script[params.agentName]
      if (!spec) throw new Error(`unexpected agent "${params.agentName}"`)
      return fakeSession(spec)
    },
  }
}

function makeCtx(taskClient) {
  const statuses = []
  const stream = {
    write: () => {}, end: async () => {},
    streamId: 's', channel: 'c', isActive: true, external: false, uuid: 'u',
    inbound: (async function* () {})(), bytes: async function* () {}, events: async function* () {},
    readable: async () => null, onEnd: () => {}, onError: () => {},
  }
  const controller = new AbortController()
  return {
    ctx: {
      taskId: 'a2a-test',
      reportStatus: m => { statuses.push(m); console.log(`  [progress] ${m}`) },
      createStream: async () => stream,
      taskClient,
      cancelSignal: controller.signal,
      isCancelled: false,
      isExpired: false,
      hasStream: true,
    },
    statuses,
  }
}

const expertArtifacts = (answer, sources) => [
  { outputId: 'answer', mimeType: 'text/plain', data: answer },
  { outputId: 'sources', mimeType: 'application/json', data: sources },
]

const assertNoOwnerId = (captured, label) => {
  for (const p of captured) ok(!('ownerId' in p), `${label}: sub-task omits ownerId (${p.agentName})`)
}

async function testHappyPath() {
  console.log('\n=== 1) orchestrator happy path (parallel fan-out, merged artifacts) ===')
  const captured = []
  const client = fakeTaskClient({
    expert_connectomics: { artifacts: expertArtifacts('Connectomics answer citing [1].', [{ title: 'C1', year: 2026, url: 'https://x/1' }]), terminal: 'completed' },
    expert_deep_learning: { artifacts: expertArtifacts('Deep learning answer citing [2].', [{ title: 'D1', year: 2025, url: 'https://x/2' }]), terminal: 'completed' },
  }, captured)
  const { ctx } = makeCtx(client)
  const task = {
    type: 'StartTask', taskId: 'a2a', agentName: 'orchestrator', ownerId: 'orig-owner', orgId: 'orig-org',
    requestParts: [
      { partId: 'question', text: 'How do connectomics and deep learning intersect?' },
      { partId: 'specialists', text: 'expert_connectomics,expert_deep_learning' },
    ],
  }
  const result = await handler(task, ctx)

  ok(result.artifacts.length === 3, `3 artifacts returned (got ${result.artifacts.length})`)
  const answer = result.artifacts.find(a => a.outputId === 'answer')
  const sources = result.artifacts.find(a => a.outputId === 'sources')
  const report = result.artifacts.find(a => a.outputId === 'report')
  ok(answer?.data.includes('Connectomics answer') && answer.data.includes('Deep learning answer'), 'merged answer contains both specialists')
  ok(sources && JSON.parse(sources.data).length === 2, 'sources artifact = union of both specialists (2 papers)')
  const r = report ? JSON.parse(report.data) : null
  ok(r && r.completed === 2 && r.total === 2, `report shows completed=${r?.completed}/${r?.total}`)
  ok(r && r.specialists.length === 2 && r.specialists.every(s => s.status === 'completed'), 'report lists both specialists as completed')
  assertNoOwnerId(captured, 'happy path')
  ok(captured.every(p => p.stream === false && p.requestParts[0].partId === 'question'), 'sub-tasks send partId "question", stream suppressed')
  console.log('  [progress events]:', ctx.statuses?.length ?? '-', '(captured above)')
}

async function testPartialFailure() {
  console.log('\n=== 2) partial failure — one specialist fails, orchestration still completes ===')
  const captured = []
  const client = fakeTaskClient({
    expert_bci_eeg: { terminal: 'failed', reason: 'boom' },
    expert_connectomics: { artifacts: expertArtifacts('Connectomics answer.', [{ title: 'C1', year: 2026, url: 'https://x/1' }]), terminal: 'completed' },
  }, captured)
  const { ctx } = makeCtx(client)
  const task = {
    type: 'StartTask', taskId: 'a2a', agentName: 'orchestrator', ownerId: 'orig-owner', orgId: 'orig-org',
    requestParts: [
      { partId: 'question', text: 'BCI connectomics question?' },
      { partId: 'specialists', text: 'expert_bci_eeg,expert_connectomics' },
    ],
  }
  const result = await handler(task, ctx) // must NOT throw
  const report = result.artifacts.find(a => a.outputId === 'report')
  const r = report ? JSON.parse(report.data) : null
  ok(r && r.completed === 1 && r.total === 2, `partial merge completes: ${r?.completed}/${r?.total}`)
  ok(r && r.specialists.find(s => s.agent === 'expert_bci_eeg')?.status === 'failed', 'failed specialist recorded with status failed')
  const answer = result.artifacts.find(a => a.outputId === 'answer')
  ok(answer?.data.includes('expert_bci_eeg (failed'), 'answer carries a partial-failure note')
  assertNoOwnerId(captured, 'partial failure')
}

async function testTimeout() {
  console.log('\n=== 3) sub-task timeout — silent specialist yields "timeout", still completes ===')
  const captured = []
  const client = fakeTaskClient({
    expert_a: { neverTerminal: true },
    expert_b: { artifacts: expertArtifacts('B answer.', []), terminal: 'completed' },
  }, captured)
  const { ctx } = makeCtx(client)
  const task = {
    type: 'StartTask', taskId: 'a2a', agentName: 'orchestrator', ownerId: 'o', orgId: 'g',
    requestParts: [
      { partId: 'question', text: 'Q?' },
      { partId: 'specialists', text: 'expert_a,expert_b' },
    ],
  }
  const result = await runOrchestrator(task, ctx, () => {}, { subTaskTimeoutMs: 200 })
  ok(result.report.completed === 1 && result.report.total === 2, 'timeout specialist does not block the merge')
  ok(result.report.specialists.find(s => s.agent === 'expert_a')?.status === 'timeout', 'silent specialist reported as timeout')
  ok(result.answer.includes('expert_a (timeout'), 'answer notes the timeout')
}

async function testPickSpecialists() {
  console.log('\n=== 4) pickSpecialists — offline topic routing (real DB) ===')
  const names = pickSpecialists('What are graph neural networks used for in connectomics?', { topN: 2 })
  ok(Array.isArray(names) && names.length === 2, `routed to 2 specialists (got ${names.length})`)
  ok(names.every(n => /^expert_/.test(n)), `names are expert_* agentNames: ${names.join(', ')}`)
  ok(names.includes('expert_connectomics'), 'connectomics question routes to expert_connectomics')
}

async function testDemoHandlers() {
  console.log('\n=== 5) echo/adder reference handlers ===')
  const echo = await echoHandler({ type: 'StartTask', requestParts: [{ partId: 'request', text: 'Hello!' }] }, { reportStatus: () => {} })
  ok(echo.artifacts[0].data === 'Echo: Hello!', 'echo returns "Echo: Hello!"')
  const adder = await adderHandler({ type: 'StartTask', requestParts: [{ partId: 'request', text: '{"kind":"math_add","a":3,"b":4}' }] }, { reportStatus: () => {} })
  ok(JSON.parse(adder.artifacts[0].data).sum === 7, 'adder computes 3 + 4 = 7')
}

async function testDemoOrchestrator() {
  console.log('\n=== 6) my_orchestrator demo — echo + adder merged over fake taskClient ===')
  const captured = []
  const client = fakeTaskClient({
    my_echo: { artifacts: [{ outputId: 'echo', mimeType: 'text/plain', data: 'Echo: Hello!' }], terminal: 'completed' },
    my_adder: { artifacts: [{ outputId: 'sum', mimeType: 'application/json', data: { sum: 7, a: 3, b: 4 } }], terminal: 'completed' },
  }, captured)
  const result = await demoOrchestrator(
    { type: 'StartTask', requestParts: [{ partId: 'request', text: 'Run the demo' }] },
    { taskClient: client, reportStatus: () => {}, cancelSignal: new AbortController().signal, isCancelled: false },
  )
  const merged = JSON.parse(result.artifacts[0].data)
  ok(merged.echo.status === 'completed' && merged.adder.status === 'completed', 'both sub-tasks completed')
  ok(merged.adder.artifacts[0].data.sum === 7, 'adder JSON artifact decoded through decodeInlineArtifact + JSON.parse')
  ok(merged.summary === 'Echo: completed, Adder: completed', 'summary line merged')
  assertNoOwnerId(captured, 'demo orchestrator')
}

async function main() {
  console.log('=== blocks A2A contract test (offline, mocked taskClient) ===')
  await testHappyPath()
  await testPartialFailure()
  await testTimeout()
  await testPickSpecialists()
  await testDemoHandlers()
  await testDemoOrchestrator()
  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL A2A CHECKS PASSED'}`)
  process.exit(failures ? 1 : 0)
}

main().catch(err => { console.error('\n[FAIL] harness threw:', err); process.exit(1) })
