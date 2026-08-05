// lit_review — multi-hop structured literature review agent.
//
// Goes a step beyond the single-expert pipeline: instead of answering from one
// topic cluster, it RETRIEVES in hops and SYNTHESIZES a structured review:
//
//   Hop 1: whole-corpus retrieval of the question (top hits across all topics)
//   Hop 2: route the question to the top-2 topic clusters (scoreTopicAffinity,
//          same signal the router + A2A orchestrator use) and retrieve deeper
//          within each
//   Hop 3: merge + dedupe into one ranked context (up to 12 papers)
//
// Then an LLM (local Ollama, ~$0 marginal cost) writes a structured review with
// fixed sections — OVERVIEW / METHOD COMPARISON / KEY FINDINGS / GAPS — citing
// the context as [n]. A retrieval-only fallback produces the same four sections
// from the ranked hits when no chat model is available (like the experts).
//
// Artifacts:
//   - answer   text/plain      the full structured review (markdown headings)
//   - sources  application/json cited papers (title, year, url)
//   - review   application/json structured { question, papers, sections, modelUsed }
//
// Inputs: "question" (required) + optional "focus" (e.g. "compare Riemannian vs
// deep-learning decoders") that sharpens the review axes.

import { rosterInfo, scoreTopicAffinity } from '../../server/agents.js'
import { search, searchTopic } from '../../server/search.js'
import { chat, chatStream, hasModel, systemMessage, userMessage, CHAT_MODEL } from '../../server/ollama.js'
import { cacheGet, cachePut } from '../../server/db.js'
import { extractQuestion } from './engine.js'

export const LIT_REVIEW_NAMESPACE = 'lit_review'

const REVIEW_PROMPT = `You are the Literature Review agent over a corpus of real arXiv papers about brain technology (BCI, EEG, neural decoding, connectomics, deep learning).

The user wants a structured literature review of the research question. Retrieve evidence ONLY from the CONTEXT block below (real paper abstracts) and cite papers as [n] using the numbers in that block.

Produce a review with EXACTLY these four markdown sections:

## OVERVIEW
One short paragraph framing the topic, the scope of the review, and how many corpus papers are relevant.

## METHOD COMPARISON
Compare the approaches found in the context. Use a compact bullet list or table: method/architecture vs dataset vs reported performance, citing each as [n]. Only include numbers that actually appear in the CONTEXT.

## KEY FINDINGS
The strongest results and the consensus across the cited papers, with [n] citations.

## GAPS
Open questions, limitations, and under-explored areas you can honestly infer from the corpus (state when the evidence is thin).

RULES:
1. Never invent papers, authors, datasets, or metrics — cite only [n] entries present in CONTEXT.
2. If the CONTEXT is thin for the question, say so plainly instead of padding.
3. Keep each section tight (a few sentences; bullets where they help).
4. Do not add sections beyond the four listed.
5. Always cite at least one paper per section when the context allows.`

// Collect { title, body } pairs for every "## Heading" section.
// Exported for tests + the review.json artifact.
export function collectSections(answer) {
  const out = []
  const lines = answer.split('\n')
  let current = null
  let buf = []
  const flush = () => {
    if (current) out.push({ title: current, body: buf.join('\n').trim() })
    buf = []
  }
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      flush()
      current = h[1].trim()
    } else {
      buf.push(line)
    }
  }
  flush()
  return out
}

// ---------- multi-hop retrieval ----------

export async function multiHopRetrieve(question, { topGlobal = 6, topPerTopic = 4, max = 12 } = {}) {
  // Hop 1: whole corpus.
  const global = search(question, { topK: topGlobal })

  // Hop 2: top-2 topic clusters by keyword affinity (same signal as router/A2A).
  const scored = scoreTopicAffinity(question, rosterInfo())
  const topics = scored.filter(s => s.kwScore > 0).slice(0, 2).map(s => s.agent.label)
  const byTopic = []
  for (const label of topics) {
    byTopic.push(...searchTopic(label, question, topPerTopic))
  }

  // Hop 3: merge + dedupe by url, keep global first then topic depth.
  const seen = new Set()
  const merged = []
  for (const r of [...global, ...byTopic]) {
    if (!r?.url || seen.has(r.url)) continue
    seen.add(r.url)
    merged.push(r)
  }
  return merged.slice(0, max)
}

// ---------- answer ----------

export async function answerLitReview(question, focus, { signal, onToken, forceNoModel = false } = {}) {
  const t0 = Date.now()
  const context = await multiHopRetrieve(question)
  const ctxBlock = context.map((r, i) =>
    `[${i + 1}] ${r.title} (${r.first_author}, ${r.year}) — topic: ${r.topic}\n${r.snippet}`
  ).join('\n\n')

  const prompt = REVIEW_PROMPT +
    (focus ? `\n\nADDITIONAL FOCUS from the caller: ${focus}. Make sure the METHOD COMPARISON and GAPS sections address it.` : '') +
    `\n\nQUESTION:\n${question}\n\nCONTEXT:\n${ctxBlock || '(no matching papers found in the corpus)'}`

  const messages = [systemMessage(prompt), userMessage(question)]
  // forceNoModel: offline tests exercise the deterministic retrieval fallback
  // (the real LLM path is verified live over the network instead).
  const llmAvailable = forceNoModel ? false : await hasModel(CHAT_MODEL)
  const modelUsed = llmAvailable

  let text = ''
  if (llmAvailable) {
    try {
      if (onToken) {
        text = await chatStream({ messages, signal, onToken })
      } else {
        text = await chat({ messages })
      }
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        return { answer: '', partial: true, context, modelUsed, durationMs: Date.now() - t0 }
      }
      throw err
    }
  }

  // Retrieval-only fallback (no chat model): build the same four sections from
  // the ranked hits — honest, cited, still structured.
  if (!llmAvailable) {
    const lines = context.map((r, i) => `${i + 1}. ${r.title} (${r.first_author}, ${r.year}) — topic: ${r.topic}`)
    text = [
      '## OVERVIEW',
      `The corpus contains ${context.length} paper(s) relevant to "${question}". The language model is unavailable, so this review is retrieval-based (ranked by relevance).`,
      '',
      '## METHOD COMPARISON',
      context.length ? lines.map(l => `- ${l}`).join('\n') : '- (no matching papers)',
      '',
      '## KEY FINDINGS',
      context.length ? 'See the ranked papers above; performance numbers are in the linked abstracts.' : 'No corpus evidence found for this question.',
      '',
      '## GAPS',
      'Insufficient evidence without a synthesis model — try again when the local LLM is available.',
    ].join('\n')
  }

  const sections = collectSections(text)
  return { answer: text, sections, context, modelUsed, durationMs: Date.now() - t0 }
}

// ---------- handler ----------

export async function runLitReview(task, ctx, emit) {
  const question = extractQuestion(task)
  const focusPart = task?.requestParts?.find(p => p.partId === 'focus')
  const focus = focusPart?.text?.trim() || null

  // Agent-scoped cache (like experts) — popular review questions skip the LLM.
  const cached = cacheGet(question, LIT_REVIEW_NAMESPACE)
  if (cached) {
    emit?.({ type: 'status', message: `Answered from cache (popular question, ${cached.hits} total hits)` })
    const context = await multiHopRetrieve(question)
    const sections = collectSections(cached.answer)
    return {
      answer: cached.answer,
      sources: context.slice(0, 8).map(c => ({ title: c.title, year: c.year, url: c.url })),
      review: {
        question, focus,
        papers: context.map(c => ({ title: c.title, year: c.year, url: c.url, first_author: c.first_author, topic: c.topic })),
        sections, modelUsed: true, cached: true,
      },
      meta: { agent: 'lit_review', cached: true, modelCalls: 0, durationMs: 0 },
    }
  }

  emit?.({ type: 'status', message: `lit_review: retrieving across the corpus (${question.slice(0, 80)})…` })
  const t0 = Date.now()

  let result
  try {
    result = await answerLitReview(question, focus, {
      signal: ctx?.cancelSignal,
      onToken: t => emit?.({ type: 'token', text: t }),
    })
  } catch (err) {
    if (err?.name === 'AbortError' || ctx?.cancelSignal?.aborted || ctx?.isCancelled) {
      emit?.({ type: 'status', message: 'Task canceled — returning partial output.' })
      return {
        answer: '(Task was canceled before the review completed.)',
        sources: [],
        review: { question, focus, papers: [], sections: [], modelUsed: false, canceled: true },
        meta: { agent: 'lit_review', cached: false, canceled: true, modelCalls: 0, durationMs: Date.now() - t0 },
      }
    }
    throw err
  }

  if (result.partial) {
    emit?.({ type: 'status', message: 'Task canceled — returning partial output.' })
    return {
      answer: result.answer.trim() || '(Task was canceled before the review completed.)',
      sources: result.context.slice(0, 8).map(c => ({ title: c.title, year: c.year, url: c.url })),
      review: { question, focus, papers: result.context.map(c => ({ title: c.title, year: c.year, url: c.url, first_author: c.first_author, topic: c.topic })), sections: [], modelUsed: result.modelUsed, canceled: true },
      meta: { agent: 'lit_review', cached: false, canceled: true, modelCalls: result.modelUsed ? 1 : 0, durationMs: result.durationMs },
    }
  }

  const answer = result.answer.trim()
  if (answer && !cached) cachePut(question, answer, 'lit_review', LIT_REVIEW_NAMESPACE)

  emit?.({ type: 'final', answer, agent: 'lit_review', cached: false, modelUsed: result.modelUsed, durationMs: result.durationMs })

  return {
    answer,
    sources: result.context.slice(0, 8).map(c => ({ title: c.title, year: c.year, url: c.url })),
    review: {
      question, focus,
      papers: result.context.map(c => ({ title: c.title, year: c.year, url: c.url, first_author: c.first_author, topic: c.topic })),
      sections: result.sections,
      modelUsed: result.modelUsed,
    },
    meta: { agent: 'lit_review', cached: false, modelCalls: result.modelUsed ? 1 : 0, durationMs: result.durationMs },
  }
}
