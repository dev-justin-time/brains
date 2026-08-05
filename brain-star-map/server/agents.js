// Agent orchestrator.
//
// Model-call layering (cheapest first):
//   0. Cache hit                    -> 0 chat calls (instant answer)
//   1. Direct lookup from data      -> 0 chat calls (stats / paper lists / authors)
//   2. Single expert + LLM          -> 1 chat call
//   3. Cross-topic consult/handoff  -> 2-3 chat calls (only for multi-topic questions)
import {
  cacheGet, cachePut, cacheRecordHit, addMessage, getPaper,
} from './db.js'
import { search, searchTopic, directLookup, embedQuestion, cosineSim, indexStats, indexLoaded } from './search.js'
import { buildRoster, formatContext, ROUTER_PROMPT, HANDOFF_PROMPT, ROUTER_ID, HANDOFF_ID } from './expertAgents.js'
import { chatStream, chat, CHAT_MODEL, hasModel, userMessage, systemMessage } from './ollama.js'

let roster = null
let centroids = null // { label: Float32Array }

function getRoster() {
  if (!roster) roster = buildRoster()
  return roster
}

// ---------- topic centroids from embeddings ----------

async function computeCentroidsAsync() {
  if (centroids) return centroids
  centroids = {}
  const { allEmbeddings, allPapers } = await import('./db.js')
  const embeddings = allEmbeddings()
  const papers = allPapers()
  const sum = new Map()
  const count = new Map()
  for (const e of embeddings) {
    const p = papers.find(x => x.id === e.paperId)
    if (!p) continue
    const label = p.community_label || 'Other'
    if (!sum.has(label)) { sum.set(label, new Float32Array(e.vector.length)); count.set(label, 0) }
    const s = sum.get(label)
    for (let i = 0; i < e.vector.length; i++) s[i] += e.vector[i]
    count.set(label, count.get(label) + 1)
  }
  for (const [label, s] of sum) {
    const n = count.get(label) || 1
    for (let i = 0; i < s.length; i++) s[i] /= n
    centroids[label] = s
  }
  return centroids
}

// ---------- routing ----------

// Keyword affinity as a base signal (label match weighted higher than keyword matches).
// Exported for reuse by the A2A orchestrator's offline specialist picker (blocks/lib/a2a.js),
// which needs the same un-normalized scoring the router uses (search() saturates at 1.0
// because it normalizes per-topic).
export function scoreTopicAffinity(question, agents) {
  const ql = question.toLowerCase()
  const kw = (a) => {
    let s = 0
    if (ql.includes(a.label.toLowerCase())) s += 2
    for (const k of a.keywords || []) {
      if (ql.includes(k)) s += 1
      else if (k.split(/\s+/).some(tok => tok.length > 3 && ql.includes(tok))) s += 0.5
    }
    return s
  }
  return agents
    .map(a => ({ agent: a, kwScore: kw(a) }))
    .sort((a, b) => b.kwScore - a.kwScore)
}

async function route(question, qVec, agents) {
  const scores = scoreTopicAffinity(question, agents)

  // Embedding affinity when available
  const cents = qVec ? await computeCentroidsAsync() : {}
  for (const s of scores) {
    const c = cents[s.agent.label]
    s.vecScore = c ? cosineSim(qVec, c) : 0
    s.score = c ? 0.6 * Math.max(s.vecScore, 0) + 0.4 * Math.min(s.kwScore, 3) / 3
      : s.kwScore > 0 ? s.kwScore : 0.001
  }

  scores.sort((a, b) => b.score - a.score)
  const picked = [scores[0].agent]
  if (scores.length > 1 && scores[1].score > 0 && scores[1].score >= scores[0].score * 0.8) {
    picked.push(scores[1].agent)
  }
  return picked
}

// ---------- consult marker parsing ----------

const CONSULT_RE = /\[\[CONSULT:([^|\]]+)\|([^\]]+)\]\]/g

function parseConsults(text) {
  const out = []
  let m
  while ((m = CONSULT_RE.exec(text)) !== null) out.push({ topic: m[1].trim(), question: m[2].trim() })
  return out
}

// ---------- main ask pipeline ----------

export async function ask(question, { emit = () => {}, stream = true, signal } = {}) {
  const t0 = Date.now()
  const q = question.trim()
  if (!q) return { answer: 'Please ask a question about the corpus.', agent: ROUTER_ID, cached: false, modelCalls: 0 }

  // Layer 0: cache
  const cached = cacheGet(q)
  if (cached) {
    cacheRecordHit(q)
    emit({ type: 'status', message: `Answered from cache (popular question, ${cached.hits} total hits)` })
    emit({ type: 'cache', hits: cached.hits })
    emit({ type: 'final', answer: cached.answer, agent: cached.agent_id, cached: true, hits: cached.hits, modelCalls: 0, durationMs: Date.now() - t0 })
    return { answer: cached.answer, agent: cached.agent_id, cached: true, hits: cached.hits, modelCalls: 0 }
  }

  // Layer 1: direct lookup from data — zero model calls
  const dl = directLookup(q)
  if (dl) {
    addMessage(ROUTER_ID, 'data', q, `direct lookup (${dl.kind})`)
    emit({ type: 'status', message: 'Answering from the corpus directly (no model call)' })
    emit({ type: 'agent_start', agent: ROUTER_ID, name: 'Router (data lookup)' })
    emit({ type: 'final', answer: dl.text, agent: ROUTER_ID, cached: false, kind: dl.kind, modelCalls: 0, durationMs: Date.now() - t0 })
    cachePut(q, dl.text, ROUTER_ID)
    return { answer: dl.text, agent: ROUTER_ID, cached: false, kind: dl.kind, modelCalls: 0 }
  }

  // Embed the question (cheap local call) for routing
  const qVec = await embedQuestion(q).catch(() => null)
  const agents = getRoster()
  emit({ type: 'status', message: `Routing question to expert agent(s)…` })

  let picked = []
  if (agents.length) picked = await route(q, qVec, agents)
  if (!picked.length) picked = [agents[0]]

  const ids = picked.map(a => a.id)
  addMessage(ROUTER_ID, ids.join(','), q, `routed to: ${picked.map(a => a.name).join(', ')}`)

  const modelCalls = { chat: 0 }
  const llmAvailable = await hasModel(CHAT_MODEL)

  const runExpert = async (agent, ctxQuery, extraContext = null) => {
    const context = searchTopic(agent.label, ctxQuery, 6)
    const ctxBlock = formatContext(context)
    const prompt =
      agent.systemPrompt +
      '\n\nCONTEXT:\n' + ctxBlock +
      (extraContext ? '\n\nADDITIONAL CONTEXT:\n' + extraContext : '')
    const messages = [systemMessage(prompt), userMessage(q)]
    if (!llmAvailable) return null
    if (stream) {
      emit({ type: 'agent_start', agent: agent.id, name: agent.name })
      const full = await chatStream({ messages, onToken: t => emit({ type: 'token', text: t }), signal })
      modelCalls.chat++
      return { text: full, context, agent }
    }
    const full = await chat({ messages })
    modelCalls.chat++
    return { text: full, context, agent }
  }

  const primary = picked[0]
  emit({ type: 'status', message: `${primary.name} is working…` })

  let primaryResult
  try {
    primaryResult = await runExpert(primary, q)
  } catch (err) {
    if (signal?.aborted) {
      emit({ type: 'status', message: 'Task canceled — stopping.' })
      return { answer: '', agent: primary.id, cached: false, modelCalls: modelCalls.chat, canceled: true, durationMs: Date.now() - t0 }
    }
    emit({ type: 'status', message: `Model call failed: ${err.message}` })
  }

  // Consult resolution + secondary expert
  let secondaryResult = null
  let consult = null
  let consultContext = null

  if (primaryResult) {
    consult = parseConsults(primaryResult.text)[0] || null
    if (consult) {
      const other = agents.find(a => a.label.toLowerCase() === (consult.topic || '').toLowerCase()) || agents.find(a => consult.topic && a.label.toLowerCase().includes(consult.topic.toLowerCase()))
      if (other && other.id !== primary.id) {
        addMessage(primary.id, other.id, consult.question, 'consult request')
        emit({ type: 'consult', from: primary.id, to: other.id, question: consult.question })
        emit({ type: 'status', message: `${primary.name} consulted ${other.name}…` })
        consultContext = searchTopic(other.label, consult.question, 4)
        addMessage(other.id, primary.id, consult.question, formatContext(consultContext))
        emit({ type: 'consult_reply', from: other.id, to: primary.id })
      }
    }
  }

  if (picked.length > 1 && llmAvailable) {
    const secondary = picked[1]
    emit({ type: 'status', message: `${secondary.name} is adding perspective…` })
    try {
      secondaryResult = await runExpert(secondary, q)
    } catch (err) {
      emit({ type: 'status', message: `Secondary agent failed: ${err.message}` })
    }
  }

  // Layer 2/3: final answer assembly
  let finalText = ''
  let finalAgent = primary.id

  if (primaryResult && !secondaryResult && !consultContext) {
    finalText = primaryResult.text
  } else if (primaryResult || secondaryResult || consultContext) {
    // Handoff merge (1 extra chat call) — but only when the LLM is available
    if (llmAvailable) {
      const parts = []
      if (primaryResult) parts.push(`[${primary.name}]\n${primaryResult.text}`)
      if (consultContext) parts.push(`[Consult reply from ${consult?.topic}]\n${formatContext(consultContext)}`)
      if (secondaryResult) parts.push(`[${secondaryResult.agent.name}]\n${secondaryResult.text}`)
      emit({ type: 'status', message: 'Handoff agent is merging answers…' })
      addMessage(HANDOFF_ID, 'user', q, 'merge of expert answers')
      try {
        const merged = await chat({
          messages: [systemMessage(HANDOFF_PROMPT), userMessage(`QUESTION: ${q}\n\nEXPERT ANSWERS:\n\n${parts.join('\n\n')}`)],
        })
        modelCalls.chat++
        finalText = merged
        finalAgent = HANDOFF_ID
      } catch (err) {
        emit({ type: 'status', message: `Handoff failed: ${err.message}` })
        finalText = parts.map(p => p.replace(/^\[[^\]]+\]/, '')).join('\n\n')
      }
    } else {
      finalText = [primaryResult?.text, consultContext ? formatContext(consultContext) : null, secondaryResult?.text]
        .filter(Boolean).join('\n\n')
    }
  } else {
    // No LLM available — fall back to retrieval-only answer
    const fallback = search(q, { topK: 5 })
    finalText = fallback.length
      ? `(LLM unavailable — retrieval result)\n\n` + fallback.map((h, i) => `${i + 1}. ${h.title} (${h.year}) — ${h.snippet}`).join('\n\n')
      : 'I could not find relevant papers, and the language model is not available to synthesize an answer. Run `ollama pull ' + CHAT_MODEL + '` to enable full answers.'
    finalAgent = 'retrieval'
  }

  finalText = finalText.replace(CONSULT_RE, '').replace(/\[\[CONSULT:[^\]]*\]\]/g, '').trim()

  const sources = (primaryResult?.context || []).map(c => ({ title: c.title, year: c.year, url: c.url })).slice(0, 5)
  cachePut(q, finalText, finalAgent)

  emit({ type: 'final', answer: finalText, agent: finalAgent, cached: false, sources, modelCalls: modelCalls.chat, embedCalls: qVec ? 1 : 0, durationMs: Date.now() - t0 })
  return { answer: finalText, agent: finalAgent, cached: false, sources, modelCalls: modelCalls.chat, embedCalls: qVec ? 1 : 0, durationMs: Date.now() - t0 }
}

// ---------- agent roster info ----------

export function rosterInfo() {
  return getRoster().map(a => ({
    id: a.id,
    name: a.name,
    label: a.label,
    paperCount: a.paperCount,
    keywords: a.keywords,
    representativePapers: a.representativePapers,
  }))
}

export { getPaper, hasModel, CHAT_MODEL }
