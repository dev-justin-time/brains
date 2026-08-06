// A2A (agent-to-agent) orchestration layer for the Blocks network.
//
// Follows the official "Set Up Agent-to-Agent (A2A) Communication" guide:
//   - ctx.taskClient is pre-authenticated (the SDK exchanges the agent's API
//     key for a consumer JWT via /api/v1/auth/agent/consumer-token) — call any
//     agent with sendMessage(); it is shared/managed by the SDK.
//   - Omit ownerId on sub-tasks: the consumer TaskClient authenticates as the
//     API key's user. Passing the original caller's task.ownerId causes a
//     PermissionDenied error.
//   - Inline artifacts arrive base64-encoded — decode with decodeInlineArtifact().
//   - Keep the client-side timeout shorter than the agent card's
//     maxRunningTimeSec so there is room to assemble the merged result.
//   - Never let one specialist take down the fan-out: partial failures produce
//     a partial result, not a failed task.
//
// Used by:
//   - the "orchestrator" agent (blocks/lib/handler.js) — auto-routes a question
//     to every topic expert with affinity (up to all six) and merges a cited
//     research brief;
//   - the echo/adder reference demo (blocks/a2a-demo/).
import { decodeInlineArtifact } from '@blocks-network/sdk'
import { rosterInfo, scoreTopicAffinity } from '../../server/agents.js'
import { extractQuestion, agentNameFor } from './engine.js'

// Must stay below the orchestrator card's maxRunningTimeSec (300s) so the
// merge + SDK overhead always fit inside the task budget. Generous because a
// specialist generation (local LLM over a multi-paper context) measured
// ~150-210s in live network runs.
export const SUB_TASK_TIMEOUT_MS = 240_000
export const MAX_AUTO_SPECIALISTS = 6

/**
 * Call one agent and resolve its terminal outcome.
 *
 * Mirrors the caller pattern from the guide: sendMessage -> onArtifact ->
 * onTerminal, with a client-side timeout and graceful failure handling.
 * Never rejects — always resolves to a SubTaskResult.
 *
 * @param {import('@blocks-network/sdk').TaskClient} taskClient
 * @param {string} agentName  must match the target's agent-card.json agentName
 * @param {Array<{partId?: string, text?: string}>} requestParts
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
 */
export async function executeSubTask(taskClient, agentName, requestParts, { timeoutMs = SUB_TASK_TIMEOUT_MS, signal } = {}) {
  try {
    // Omit ownerId — the consumer TaskClient uses the API key's identity.
    // Do NOT pass the original caller's task.ownerId; the gateway rejects it.
    const session = await taskClient.sendMessage({ agentName, requestParts, stream: false })

    return await new Promise((resolve) => {
      let settled = false
      const artifacts = []

      const finish = (outcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        session.close()
        resolve(outcome)
      }

      const timer = setTimeout(() => {
        finish({ status: 'timeout', agentName, error: `${agentName} timed out after ${Math.round(timeoutMs / 1000)}s`, artifacts })
      }, timeoutMs)

      const onAbort = () => finish({ status: 'canceled', agentName, error: 'orchestration canceled', artifacts })
      signal?.addEventListener?.('abort', onAbort, { once: true })

      session.onArtifact((event) => {
        const ref = event.artifactRef
        if (ref?.kind === 'inline') {
          const text = new TextDecoder().decode(decodeInlineArtifact(ref))
          let data = text
          try { data = JSON.parse(text) } catch { /* keep as text */ }
          artifacts.push({ outputId: event.outputId, mimeType: ref.mimeType, data })
        } else {
          artifacts.push({ outputId: event.outputId, mimeType: ref?.mimeType, ref })
        }
      })

      session.onTerminal((event) => {
        if (event.state === 'completed') {
          finish({ status: 'completed', agentName, artifacts })
        } else {
          finish({ status: 'failed', agentName, error: event.reason || event.error || event.state, artifacts })
        }
      })
    })
  } catch (err) {
    return { status: 'failed', agentName, error: err?.message ?? 'sendMessage failed', artifacts: [] }
  }
}

/**
 * Run independent sub-tasks in parallel. The network routes each call to the
 * right agent; Promise.all keeps the fan-out concurrent.
 */
export async function runParallel(taskClient, calls, opts) {
  return Promise.all(calls.map(c => executeSubTask(taskClient, c.agentName, c.requestParts, opts)))
}

/**
 * Choose which specialists to fan out to — offline, no LLM call.
 *
 * Default: auto-route among roster experts — every expert whose keyword
 * affinity scores > 0 is included, capped at six specialists,
 * so a cross-topic question fans out to every relevant specialist instead of
 * a fixed top-2. Pass `topN` to cap the fan-out explicitly.
 *
 * Uses the same un-normalized keyword affinity the router uses (scoreTopicAffinity):
 * label match in the question counts +2, topic keywords +1 (or +0.5 for token-level
 * matches). search() can't be used here — it normalizes per-topic, so every topic
 * would saturate at 1.0 and routing could not differentiate.
 * Fallback: the top-scoring roster agents (deterministic) when nothing scores.
 */
export function pickSpecialists(question, { topN } = {}) {
  const roster = rosterInfo()
  const scored = scoreTopicAffinity(question, roster)
  const requested = topN === undefined ? MAX_AUTO_SPECIALISTS : Number(topN)
  const safeTopN = Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : MAX_AUTO_SPECIALISTS
  // No cap given -> route to every expert with any affinity, capped at six.
  // Explicit topN still honors a smaller fan-out.
  // Keep the default fan-out bounded even if the corpus later grows beyond
  // the six specialist agents the orchestrator is designed to coordinate.
  // An explicit topN may request a smaller limit, but never a larger one.
  const limit = Math.min(safeTopN, MAX_AUTO_SPECIALISTS, roster.length)
  const chosen = scored.filter(s => s.kwScore > 0).slice(0, limit)
  const list = chosen.length ? chosen : scored.slice(0, limit)
  return list.map(s => agentNameFor(s.agent.id))
}

/**
 * Merge N specialist outcomes into a single unified response:
 *   - answer:  one text brief concatenating each completed specialist's answer
 *   - sources: deduped union of every cited paper (sources artifacts)
 *   - report:  structured per-specialist breakdown (agent, status, answer, sources)
 */
export function compileBrief(question, results) {
  const sections = []
  const sourcesMap = new Map()
  const perSpecialist = []

  for (const r of results) {
    const answerArtifact = r.artifacts?.find(a => a.outputId === 'answer')
    const sourcesArtifact = r.artifacts?.find(a => a.outputId === 'sources')

    let src = []
    if (sourcesArtifact) {
      const raw = sourcesArtifact.data
      if (Array.isArray(raw)) src = raw
      else if (typeof raw === 'string') { try { src = JSON.parse(raw) } catch { src = [] } }
      else src = []
    }
    for (const s of src) {
      if (s && s.title) sourcesMap.set(s.url || s.title, { title: s.title, year: s.year, url: s.url })
    }

    const ok = r.status === 'completed'
    const answer = ok && answerArtifact
      ? (typeof answerArtifact.data === 'string' ? answerArtifact.data : JSON.stringify(answerArtifact.data))
      : null
    perSpecialist.push({
      agent: r.agentName,
      status: r.status,
      error: r.error || null,
      answer,
      sources: src,
    })
    if (ok && answer) sections.push(`## ${r.agentName}\n${answer.trim()}`)
  }

  const incomplete = results.filter(r => r.status !== 'completed')
  const note = incomplete.length
    ? `\n\n> Note: ${incomplete.map(f => `${f.agentName} (${f.status}${f.error ? `: ${f.error}` : ''})`).join(', ')} did not complete — the brief above covers the specialists that did.`
    : ''

  const answer = sections.length
    ? `Merged research brief for: ${question}\n\n${sections.join('\n\n')}${note}`
    : `No specialist returned a completed answer.${incomplete.length ? ` Incomplete: ${incomplete.map(f => `${f.agentName} (${f.error || f.status})`).join('; ')}.` : ''}`

  return {
    answer,
    sources: Array.from(sourcesMap.values()),
    report: {
      question,
      specialists: perSpecialist,
      completed: results.filter(r => r.status === 'completed').length,
      total: results.length,
    },
  }
}

/**
 * The "orchestrator" pipeline: route the question to specialists, call them in
 * parallel over the network, and merge into one artifact set.
 *
 * @returns {{answer: string, sources: Array, report: object, meta: object}}
 */
export async function runOrchestrator(task, ctx, emit, { subTaskTimeoutMs = SUB_TASK_TIMEOUT_MS } = {}) {
  const question = extractQuestion(task)

  // Optional explicit specialist list (requestParts partId "specialists"),
  // otherwise auto-route among ALL topic experts with affinity (up to six).
  const specialistsPart = task?.requestParts?.find(p => p.partId === 'specialists')
  let agents = []
  if (specialistsPart?.text?.trim()) {
    // Explicit lists are also used by offline A2A tests and by callers that
    // may target a separately published expert roster. Enforce the published
    // specialist naming contract without importing a fixed live roster here.
    agents = [...new Set(specialistsPart.text
      .split(',')
      .map(s => s.trim())
      .filter(name => /^expert_[a-zA-Z0-9_]+$/.test(name)))]
      .slice(0, MAX_AUTO_SPECIALISTS)
    if (!agents.length) throw new Error('No valid specialists selected — use expert_* agent names.')
  } else {
    agents = pickSpecialists(question)
  }
  if (!agents.length) {
    throw new Error('No specialists selected — pass requestParts partId "specialists" or fix the corpus roster.')
  }

  if (!ctx?.taskClient) {
    throw new Error('A2A requires ctx.taskClient (pre-authenticated) — run this agent via `blocks run` on the network.')
  }

  emit({ type: 'status', message: `Fanning out to ${agents.length} specialist(s) in parallel: ${agents.join(', ')}` })
  const t0 = Date.now()

  const results = await runParallel(
    ctx.taskClient,
    agents.map(name => ({ agentName: name, requestParts: [{ partId: 'question', text: question }] })),
    { timeoutMs: subTaskTimeoutMs, signal: ctx?.cancelSignal },
  )

  for (const r of results) {
    emit({ type: 'status', message: `${r.agentName}: ${r.status}${r.status === 'completed' ? ` (${r.artifacts?.length ?? 0} artifacts)` : r.error ? ` — ${r.error}` : ''}` })
  }

  emit({ type: 'status', message: 'Compiling merged research brief…' })
  const brief = compileBrief(question, results)
  emit({ type: 'status', message: brief.report.completed === brief.report.total
    ? `Merged ${brief.report.completed}/${brief.report.total} specialist answers.`
    : `Partial merge: ${brief.report.completed}/${brief.report.total} specialist answers.` })

  return {
    ...brief,
    meta: {
      agent: 'orchestrator',
      durationMs: Date.now() - t0,
      subTasks: results.map(r => ({ agent: r.agentName, status: r.status, error: r.error || null })),
    },
  }
}
