// ADA Syndicate agents — ported from the ADA Protocol Autonomous Syndicate
// backend and wired into the shared Blocks handler.
//
//   - ada_syndicate   the ADA Protocol engine as an agent: SENTINEL security
//                     sweep -> ADA semantic cache -> knowledge-base grounding
//                     -> persona routing (15 experts, explicit agent_id or
//                     auto-route by intent) -> persona LLM synthesis -> cache
//                     store. Returns answer + sources + a structured ada.json
//                     artifact ({ status: BLOCKED|CACHE_HIT|LLM_GROUNDED|LLM_FALLBACK, ... }).
//   - ada_fact_check  LLM-free DOI retraction / validity check.
//   - ada_harvest     LLM-free arXiv scrape (the Paper Agent), reusing the
//                     same live arXiv client as paper_updates.

import { ADACache, KnowledgeBase } from '../../ada/engine.js'
import { EXPERT_REGISTRY, resolvePersona, PERSONA_LIST } from '../../ada/experts.js'
import { securitySweep, factCheck, harvestPapers, discoverBridges, dataAdvise } from '../../ada/infra.js'
import { chat, chatStream, hasModel, systemMessage, userMessage, CHAT_MODEL } from '../../server/ollama.js'
import { extractQuestion } from './engine.js'

export const ADA_NAMESPACE = 'ada_syndicate'

// Process-wide semantic cache (MD5 + 24h TTL), exactly like ADACache in the
// Python original — duplicated per-process by design.
export const adaCache = new ADACache()
export const adaKb = new KnowledgeBase()

// Parallel cache storing the persona + grounded sources that produced each
// cached answer, so a CACHE_HIT can repopulate metadata instead of returning
// `persona: null, sources: []` (the UI renders a sources panel from it).
export const adaMetaCache = new ADACache()

const SYNDICATE_PROMPT = `You are a member of the ADA Syndicate, a council of 15 reasoning experts.
Answer the user's query from your persona's grounding instruction using the ADA PROTOCOL CONTEXT below.
Cite grounded papers by title and year exactly as given. If the CONTEXT is empty or insufficient, say so plainly
and prefix your answer with "[Fallback Mode]". Never invent citations, DOIs, or paper titles.`

// Map a knowledge-base entry to the shared sources artifact shape. Corpus
// entries carry a live arXiv `url` (public/graph_data.json has no DOIs); the
// original sample entries carry a `doi` and fall back to doi.org links.
function toSource(entry) {
  return {
    title: entry.paper_title,
    year: entry.year,
    url: entry.url || (entry.doi ? `https://doi.org/${entry.doi}` : null),
    domain: entry.domain,
  }
}

/**
 * Run the ADA Protocol for a question: security -> cache -> KB -> persona -> LLM.
 * @param {{ signal?: AbortSignal, onToken?: (t:string)=>void, forceNoModel?: boolean, cache?: ADACache, kb?: KnowledgeBase }} [opts]
 */
export async function answerAdaSyndicate(question, agentId, opts = {}) {
  const { signal, onToken, forceNoModel = false, cache = adaCache, kb = adaKb } = opts
  const t0 = Date.now()

  // 1. SECURITY SWEEP (Sentinel)
  const sec = securitySweep(question)
  if (!sec.is_safe) {
    return {
      answer: 'BLOCKED: this request was stopped by the ADA Sentinel security sweep.\n' +
        `Threats detected: ${sec.threats.join('; ')}`,
      sources: [],
      ada: { status: 'BLOCKED', persona: null, context_used: 0, threats: sec.threats, modelUsed: false, cached: false, durationMs: Date.now() - t0 },
    }
  }

  // 1b. INFRA INTENTS — LLM-free fast paths (the Discovery + Data agents),
  // reachable so the ported meta-agent logic is actually wired in.
  if (/bridge papers|discover bridges|betweenness|interdisciplinary hub/i.test(question)) {
    const { bridges, error } = discoverBridges(3)
    const lines = bridges.map((b, i) => `${i + 1}. ${b.title} — betweenness ${b.bridge_score} (${b.action})`)
    return {
      answer: bridges.length
        ? 'Top bridge papers (highest betweenness centrality — they link otherwise-separate research clusters):\n' + lines.join('\n')
        : `Bridge discovery unavailable: ${error || 'no bridges found'}`,
      sources: bridges.map(b => ({ title: b.title, url: `https://arxiv.org/abs/${b.node_id}` })),
      ada: { status: 'INFRA', intent: 'discover_bridges', persona: null, context_used: 0, threats: [], modelUsed: false, cached: false, durationMs: Date.now() - t0 },
    }
  }
  if (/advise on (the )?(infrastructure|database)|database health|(our|the|this) (database|vector index|infrastructure|hnsw)|hnsw (index|indexing|config)/i.test(question)) {
    return {
      answer: `[Data Agent] ${dataAdvise()}`,
      sources: [],
      ada: { status: 'INFRA', intent: 'data_advise', persona: null, context_used: 0, threats: [], modelUsed: false, cached: false, durationMs: Date.now() - t0 },
    }
  }

  // 2. CACHE CHECK (ADA Step 1)
  const cached = cache.get(question)
  if (cached) {
    const meta = adaMetaCache.get(question) || { persona: null, sources: [] }
    return {
      answer: cached,
      sources: meta.sources || [],
      ada: { status: 'CACHE_HIT', persona: meta.persona || null, context_used: (meta.sources || []).length, threats: [], modelUsed: false, cached: true, durationMs: 0 },
    }
  }

  // 3. PERSONA ROUTING (explicit agent_id wins, else intent auto-route)
  const persona = resolvePersona(agentId, question)

  // 4. CSV/KB LOOKUP (ADA Step 2) — grounded by the persona's domain slice
  const context = kb.search(question, persona.kbDomain, 3)

  // 5. AGENT SYNTHESIS (ADA Step 3)
  const prompt = SYNDICATE_PROMPT + '\n\n' + persona.generatePrompt(question, context)
  const messages = [systemMessage(prompt), userMessage(question)]
  const llmAvailable = forceNoModel ? false : await hasModel(CHAT_MODEL)

  let text = ''
  if (llmAvailable) {
    try {
      text = onToken ? await chatStream({ messages, signal, onToken }) : await chat({ messages })
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        return { answer: '', partial: true, persona, context, modelUsed: true, ada: null, durationMs: Date.now() - t0 }
      }
      throw err
    }
  }

  // Deterministic fallback (no chat model): persona + grounded papers, honest.
  if (!llmAvailable) {
    const lines = context.map((e, i) => `${i + 1}. ${e.paper_title} (${e.year}, ${e.domain}) — ${e.abstract}`)
    text = `[${persona.displayName} — ${persona.domain}]\n` +
      `[Fallback Mode] The language model is unavailable, so this answer is retrieval-based (ADA protocol, no synthesis).\n\n` +
      (lines.length
        ? `Grounded in ${context.length} knowledge-base paper(s):\n${lines.join('\n\n')}`
        : `No knowledge-base papers matched "${question}" in the ${persona.kbDomain} domain.`)
  }

  // 6. STORE IN CACHE (answer + the persona/sources metadata that produced it)
  if (text) {
    cache.set(question, text)
    adaMetaCache.set(question, { persona: persona.name, sources: context.map(toSource) })
  }

  return {
    answer: text,
    sources: context.map(toSource),
    persona,
    context,
    modelUsed: llmAvailable,
    ada: {
      status: context.length ? 'LLM_GROUNDED' : 'LLM_FALLBACK',
      persona: persona.name,
      context_used: context.length,
      threats: [],
      modelUsed: llmAvailable,
      cached: false,
      durationMs: Date.now() - t0,
    },
    durationMs: Date.now() - t0,
  }
}

export async function runAdaSyndicate(task, ctx, emit) {
  const question = extractQuestion(task)
  const agentPart = task?.requestParts?.find(p => p.partId === 'agent_id')
  const agentId = agentPart?.text?.trim() || null

  ctx?.reportStatus?.(`ADA Syndicate: routing to a persona for "${question.slice(0, 80)}"…`)

  let result
  try {
    result = await answerAdaSyndicate(question, agentId, {
      signal: ctx?.cancelSignal,
      onToken: t => emit?.({ type: 'token', text: t }),
    })
  } catch (err) {
    if (err?.name === 'AbortError' || ctx?.cancelSignal?.aborted || ctx?.isCancelled) {
      return {
        answer: '(Task was canceled before the ADA protocol completed.)',
        sources: [],
        ada: { status: 'CANCELED', persona: null, context_used: 0, threats: [], modelUsed: false, cached: false },
        meta: { agent: 'ada_syndicate', cached: false, canceled: true, modelCalls: 0, durationMs: 0 },
      }
    }
    throw err
  }

  if (result.partial) {
    return {
      answer: result.answer.trim() || '(Task was canceled before the ADA protocol completed.)',
      sources: [],
      ada: { status: 'CANCELED', persona: null, context_used: 0, threats: [], modelUsed: true, cached: false },
      meta: { agent: 'ada_syndicate', cached: false, canceled: true, modelCalls: 1, durationMs: result.durationMs },
    }
  }

  emit?.({ type: 'status', message: `ADA Syndicate: ${result.ada.status} (${result.ada.intent || result.persona?.name || 'n/a'})` })
  return {
    answer: result.answer,
    sources: result.sources,
    ada: result.ada,
    meta: {
      agent: 'ada_syndicate',
      cached: result.ada.cached,
      modelCalls: result.modelUsed ? 1 : 0,
      durationMs: result.durationMs,
      status: result.ada.status,
    },
  }
}

// ---------- ada_fact_check (LLM-free) ----------

const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/

export async function runAdaFactCheck(task, ctx) {
  const question = extractQuestion(task)
  ctx?.reportStatus?.('ada_fact_check: checking DOI validity / retraction status (no LLM)…')

  // Sentinel sweep, consistent with the syndicate — cheap and no LLM path,
  // but keeps the security story uniform across all ADA agents.
  const sec = securitySweep(question)
  if (!sec.is_safe) {
    return {
      artifacts: [{
        data: `BLOCKED: the ADA Sentinel security sweep stopped this request.\nThreats: ${sec.threats.join('; ')}`,
        mimeType: 'text/plain',
        outputId: 'answer',
      }],
    }
  }

  const doiMatch = DOI_RE.exec(question)
  let doi = doiMatch ? doiMatch[0] : null

  // No DOI in the question? Try matching a paper title against the KB.
  let matched = null
  if (!doi) {
    const ql = question.toLowerCase().replace(/[.,]/g, '')
    const qTerms = ql.split(/\s+/).filter(t => t.length > 3)
    for (const entry of adaKb.data) {
      const t = `${entry.paper_title} ${entry.topic} ${entry.concept}`.toLowerCase()
      const hits = qTerms.filter(term => t.includes(term)).length
      if (hits >= 2 && (!matched || hits > matched.hits)) matched = { hits, entry }
    }
    if (matched) doi = matched.entry.doi
  }

  const check = factCheck(doi)
  const source = matched ? toSource(matched.entry) : null
  // Corpus entries have no DOI; surface their arXiv reference instead so a
  // title-matched paper doesn't print "(not found)". The status stays UNKNOWN
  // (factCheck(undefined)) — honest: we know the paper exists, not its
  // retraction record.
  const doiLabel = doi || (matched?.entry?.url ? `arxiv: ${matched.entry.url}` : '(not found in the question or knowledge base)')
  const lines = [
    `DOI: ${doiLabel}`,
    `Status: ${check.status}`,
  ]
  if (check.warning) lines.push(check.warning)
  if (source) lines.push(`Grounding paper: ${source.title} (${source.year}) — ${source.url}`)
  else lines.push('No knowledge-base entry matched; the status is a heuristic DOI check, not an external registry lookup.')

  const artifacts = [{ data: lines.join('\n'), mimeType: 'text/plain', outputId: 'answer' }]
  if (source) {
    artifacts.push({ data: JSON.stringify([source], null, 2), mimeType: 'application/json', outputId: 'sources', fileName: 'sources.json' })
  }
  return { artifacts }
}

// ---------- ada_harvest (LLM-free, live arXiv) ----------

export async function runAdaHarvest(task, ctx, { fetcher } = {}) {
  const topicPart = task?.requestParts?.find(p => p.partId === 'topic')
  const topic = topicPart?.text?.trim() || 'brain-computer interface'

  // Sentinel sweep on the incoming topic.
  const sec = securitySweep(topic)
  if (!sec.is_safe) {
    return {
      artifacts: [{
        data: `BLOCKED: the ADA Sentinel security sweep stopped this request.\nThreats: ${sec.threats.join('; ')}`,
        mimeType: 'text/plain',
        outputId: 'answer',
      }],
    }
  }

  ctx?.reportStatus?.(`ada_harvest: scraping arXiv for the newest papers on "${topic.slice(0, 60)}"…`)

  const papers = await harvestPapers(topic, 10, { fetcher })
  const lines = papers.map((p, i) => `${i + 1}. ${p.title} — ${(p.authors || []).slice(0, 3).join(', ')}, ${p.year} (${p.url})`)
  const artifacts = [
    {
      data: `Harvested ${papers.length} recent arXiv paper(s) on "${topic}" (source: live arXiv API):\n\n` + lines.join('\n'),
      mimeType: 'text/plain',
      outputId: 'answer',
    },
  ]
  if (papers.length) {
    artifacts.push({
      data: JSON.stringify(papers, null, 2),
      mimeType: 'application/json',
      outputId: 'sources',
      fileName: 'papers.json',
    })
  }
  return { artifacts }
}

export { EXPERT_REGISTRY, PERSONA_LIST }
