// Blocks-compatible pipeline for the brain-tech expert-agent network.
//
// This module is the "handler core" shared by every agent card in blocks/agents/.
// It implements the Blocks key concepts on top of the existing server engine:
//   - Tasks (request kind) delivered via requestParts with a declared partId
//   - Progress/status reporting (ctx.reportStatus -> { type:'progress' } events)
//   - Outbound bytes stream for token-by-token answer streaming
//   - Text + structured JSON artifacts (io.outputs: answer, sources)
//   - Cooperative cancellation (ctx.cancelSignal / ctx.isCancelled)
//
// The handler itself (lib/handler.js) resolves which agent a task targets from
// task.agentName and delegates here.
import {
  ask,
  rosterInfo,
} from '../../server/agents.js'
import { buildRoster, formatContext } from '../../server/expertAgents.js'
import { searchTopic } from '../../server/search.js'
import { chat, chatStream, hasModel, systemMessage, userMessage, CHAT_MODEL } from '../../server/ollama.js'
import { cacheGet, cachePut, addMessage } from '../../server/db.js'

// Strip consult markers from an expert's raw reply. In the Blocks network an
// expert answers its own task directly (there is no in-process handoff), so
// markers have no recipient and must not leak into the artifact.
const CONSULT_RE = /\[\[CONSULT:[^\]]*\]\]/g

// ---------- task input (requestParts + partId) ----------

export function extractQuestion(task) {
  const parts = task?.requestParts || []
  if (!parts.length) {
    throw new Error('Missing requestParts — send requestParts: [{ partId: "question", text: "..." }]')
  }
  const byId = parts.filter(p => p.partId === 'question')
  const noId = parts.filter(p => !p.partId)
  const mismatched = parts.find(p => p.partId && p.partId !== 'question')
  // Blocks rejects a mismatched partId before the handler runs — enforce the same contract.
  if (mismatched && !byId.length) {
    throw new Error(`requestParts partId "${mismatched.partId}" does not match the declared input "question"`)
  }
  const part = byId[0] || noId[0]
  const text = (part?.text ?? '').trim()
  if (!text) {
    throw new Error('Missing required input "question" — send requestParts: [{ partId: "question", text: "..." }]')
  }
  return text
}

// ---------- agent identity ----------

// Roster ids look like "expert:bci_eeg"; Blocks agentName must match ^[a-zA-Z0-9_]+$.
export function agentNameFor(id) {
  return String(id).replace(/[^a-zA-Z0-9_]/g, '_')
}

export function resolveAgent(agentName) {
  const roster = rosterInfo()
  const wanted = String(agentName || '')
  const found = roster.find(a => agentNameFor(a.id) === wanted) ||
    roster.find(a => a.label === wanted) ||
    roster.find(a => a.name === wanted)
  if (!found) {
    const known = roster.map(a => `${agentNameFor(a.id)} (${a.label})`).join(', ')
    throw new Error(`Unknown agent "${agentName}". Known agents: ${known}, router`)
  }
  // rosterInfo() drops systemPrompt; rebuild the full agent object for prompts.
  return buildRoster().find(a => a.id === found.id)
}

// ---------- streaming ----------

// Create the outbound "tokens" bytes stream. Returns null when streaming is
// unavailable (no ctx, createStream missing, or the task has no stream — the
// guide's `ctx.hasStream` opt-in check, plus a fallback for callers that
// omit it). Extra opts (e.g. { bundleSizeBytes, maxLatencyMs } from the
// Stream guide's request example) are passed straight through.
export async function buildStream(ctx, opts = {}) {
  if (!ctx?.createStream || ctx.hasStream === false) return null
  try {
    // Hardcoded keys first so callers can't override direction/format/stream key.
    return await ctx.createStream({ ...opts, direction: 'outbound', format: 'bytes', declaredStream: '_default' })
  } catch {
    return null
  }
}

// ---------- artifacts ----------

export function makeArtifacts(answer, sources = []) {
  const artifacts = [{ data: answer, mimeType: 'text/plain', outputId: 'answer' }]
  const src = (sources || []).map(s => ({ title: s.title, year: s.year, url: s.url }))
  if (src.length) {
    artifacts.push({
      data: JSON.stringify(src, null, 2),
      mimeType: 'application/json',
      outputId: 'sources',
      fileName: 'sources.json',
    })
  }
  return artifacts
}

// ---------- router execution (full multi-expert pipeline) ----------

export async function runRouter(task, ctx, emit) {
  const question = extractQuestion(task)
  const result = await ask(question, { emit, stream: true, signal: ctx?.cancelSignal })
  return {
    answer: result.answer,
    sources: result.sources || [],
    meta: {
      agent: result.agent,
      cached: !!result.cached,
      modelCalls: result.modelCalls || 0,
      durationMs: result.durationMs,
    },
  }
}

// ---------- single-expert execution (specialty answer) ----------

export async function runExpert(agent, task, ctx, emit) {
  const question = extractQuestion(task)
  const t0 = Date.now()

  // Agent-scoped popular-question cache (fewer model calls — same DB as the
  // web app, namespaced per agent so experts never serve router answers).
  const cached = cacheGet(question, agent.id)
  if (cached) {
    emit({ type: 'status', message: `Answered from cache (popular question, ${cached.hits} total hits)` })
    // Re-derive sources so the sources artifact is populated even on a cache hit.
    const context = searchTopic(agent.label, question, 5)
    return {
      answer: cached.answer,
      sources: context.map(c => ({ title: c.title, year: c.year, url: c.url })),
      meta: { agent: agent.id, cached: true, modelCalls: 0, durationMs: Date.now() - t0 },
    }
  }

  // Retrieval restricted to this expert's topic cluster.
  const context = searchTopic(agent.label, question, 6)
  const prompt = agent.systemPrompt + '\n\nCONTEXT:\n' + formatContext(context)
  const messages = [systemMessage(prompt), userMessage(question)]

  emit({ type: 'status', message: `${agent.name} is searching ${agent.paperCount} papers in ${agent.label}…` })
  const llmAvailable = await hasModel(CHAT_MODEL)

  let text = ''
  let partial = ''
  if (llmAvailable) {
    emit({ type: 'agent_start', agent: agent.id, name: agent.name })
    try {
      if (ctx?.createStream) {
        text = await chatStream({
          messages,
          signal: ctx?.cancelSignal,
          onToken: t => { partial += t; emit({ type: 'token', text: t }) },
        })
      } else {
        text = await chat({ messages })
      }
    } catch (err) {
      // Cooperative cancel: return the partial output instead of failing.
      if (err?.name === 'AbortError' || ctx?.cancelSignal?.aborted || ctx?.isCancelled) {
        emit({ type: 'status', message: 'Task canceled — returning partial output.' })
        return {
          answer: partial.trim() ? partial.trim() : '(Task was canceled before any answer was produced.)',
          sources: context.map(c => ({ title: c.title, year: c.year, url: c.url })).slice(0, 5),
          meta: { agent: agent.id, cached: false, canceled: true, modelCalls: 0, durationMs: Date.now() - t0 },
        }
      }
      throw err
    }
  } else {
    // No chat model — retrieval-only answer.
    text = context.length
      ? '(LLM unavailable — retrieval result)\n\n' + context.map((c, i) => `${i + 1}. ${c.title} (${c.year}) — ${c.snippet}`).join('\n\n')
      : `I could not find relevant papers in ${agent.label}, and the language model is not available.`
  }

  text = text.replace(CONSULT_RE, '').trim()

  // Log the exchange to the shared agent-message log (SQLite).
  addMessage(agent.id, 'user', question, 'Blocks task answer')
  cachePut(question, text, agent.id, agent.id)

  const sources = context.map(c => ({ title: c.title, year: c.year, url: c.url })).slice(0, 5)
  emit({ type: 'final', answer: text, agent: agent.id, cached: false })
  return {
    answer: text,
    sources,
    meta: { agent: agent.id, cached: false, modelCalls: llmAvailable ? 1 : 0, durationMs: Date.now() - t0 },
  }
}
