// grant_writer — research idea -> draft proposal (background + related work).
//
// Takes a research idea ("I want to combine foundation models with Riemannian
// decoding for cross-subject EEG") and drafts the front matter of a grant /
// research proposal: TITLE, BACKGROUND, RELATED WORK (with [n] citations from
// the corpus), PROPOSED CONTRIBUTION, and RISKS. Reuses the lit_review
// multi-hop retrieval so related work spans the whole corpus + top-2 topics.
//
// Structured draft.json artifact (idea, papers, parsed sections) + sources.
//
// Note: the "funding/grant text corpus" from the roadmap is not bundled — the
// draft is generated from the papers corpus (real citations) plus a templated
// structure, which is the honest scope without scraping external grant text.

import { chat, chatStream, hasModel, systemMessage, userMessage, CHAT_MODEL } from '../../server/ollama.js'
import { cacheGet, cachePut } from '../../server/db.js'
import { extractQuestion } from './engine.js'
import { multiHopRetrieve, collectSections } from './litreview.js'

export const GRANT_NAMESPACE = 'grant_writer'

const GRANT_PROMPT = `You are the Grant Writer agent for a corpus of real arXiv papers about brain technology (BCI, EEG, neural decoding, connectomics, deep learning).

The caller gives a RESEARCH IDEA. Draft the front matter of a credible research grant proposal. Cite papers as [n] using ONLY the CONTEXT numbers.

Write EXACTLY these five markdown sections:

## TITLE
A strong, specific working title (under 15 words).

## BACKGROUND
2-4 sentences: why this problem matters and the state of the field, citing [n].

## RELATED WORK
A compact bullet list (3-6 items) of the most relevant existing work from the CONTEXT, one line each: what they did and the gap your idea fills, citing [n].

## PROPOSED CONTRIBUTION
2-4 sentences: what the proposal will do that is new, the expected outcome, and why it is feasible.

## RISKS & OPEN QUESTIONS
1-3 honest risks (data availability, generalization, evaluation) and how you would mitigate them.

RULES:
1. Never invent papers, authors, datasets, or numbers — cite only [n] entries present in CONTEXT.
2. If CONTEXT is thin, say so and keep RELATED WORK short rather than padding.
3. Stay realistic: do not promise results no corpus evidence supports.
4. Do not add sections beyond the five listed.`

export async function answerGrantQuestion(idea, { signal, onToken, forceNoModel = false } = {}) {
  const t0 = Date.now()
  const context = await multiHopRetrieve(idea, { topGlobal: 8, topPerTopic: 5, max: 14 })
  const ctxBlock = context.map((r, i) =>
    `[${i + 1}] ${r.title} (${r.first_author}, ${r.year}) — topic: ${r.topic}\n${r.snippet}`
  ).join('\n\n')

  const prompt = GRANT_PROMPT + `\n\nRESEARCH IDEA:\n${idea}\n\nCONTEXT:\n${ctxBlock || '(no matching papers found in the corpus)'}`
  const messages = [systemMessage(prompt), userMessage(idea)]

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

  if (!llmAvailable) {
    const lines = context.map((r, i) => `${i + 1}. ${r.title} (${r.first_author}, ${r.year}) — topic: ${r.topic}`)
    text = [
      '## TITLE',
      '(Working title — needs the synthesis model to draft.)',
      '',
      '## BACKGROUND',
      `This proposal builds on ${context.length} relevant paper(s) from the corpus. The language model is unavailable, so this is a retrieval-only draft.`,
      '',
      '## RELATED WORK',
      context.length ? lines.map(l => `- ${l}`).join('\n') : '- (no matching papers)',
      '',
      '## PROPOSED CONTRIBUTION',
      'See the ranked papers above; a full contribution narrative requires the synthesis model.',
      '',
      '## RISKS & OPEN QUESTIONS',
      'Retrieval-only draft — run again when the local LLM is available.',
    ].join('\n')
  }

  const sections = collectSections(text)
  return { answer: text.trim(), sections, context, modelUsed, durationMs: Date.now() - t0 }
}

export async function runGrantWriter(task, ctx, emit) {
  const idea = extractQuestion(task)

  const cached = cacheGet(idea, GRANT_NAMESPACE)
  if (cached) {
    emit?.({ type: 'status', message: `Answered from cache (popular question, ${cached.hits} total hits)` })
    const context = await multiHopRetrieve(idea)
    const sections = collectSections(cached.answer)
    return {
      answer: cached.answer,
      sources: context.slice(0, 8).map(c => ({ title: c.title, year: c.year, url: c.url })),
      draft: { idea, papers: context.map(c => ({ title: c.title, year: c.year, url: c.url, first_author: c.first_author, topic: c.topic })), sections, modelUsed: true, cached: true },
      meta: { agent: 'grant_writer', cached: true, modelCalls: 0, durationMs: 0 },
    }
  }

  emit?.({ type: 'status', message: `grant_writer: researching related work for "${idea.slice(0, 80)}"…` })
  const t0 = Date.now()

  let result
  try {
    result = await answerGrantQuestion(idea, {
      signal: ctx?.cancelSignal,
      onToken: t => emit?.({ type: 'token', text: t }),
    })
  } catch (err) {
    if (err?.name === 'AbortError' || ctx?.cancelSignal?.aborted || ctx?.isCancelled) {
      emit?.({ type: 'status', message: 'Task canceled — returning partial output.' })
      return {
        answer: '(Task was canceled before the draft was completed.)',
        sources: [],
        draft: { idea, papers: [], sections: [], modelUsed: false, canceled: true },
        meta: { agent: 'grant_writer', cached: false, canceled: true, modelCalls: 0, durationMs: Date.now() - t0 },
      }
    }
    throw err
  }

  if (result.partial) {
    emit?.({ type: 'status', message: 'Task canceled — returning partial output.' })
    return {
      answer: result.answer.trim() || '(Task was canceled before the draft was completed.)',
      sources: result.context.slice(0, 8).map(c => ({ title: c.title, year: c.year, url: c.url })),
      draft: { idea, papers: result.context.map(c => ({ title: c.title, year: c.year, url: c.url, first_author: c.first_author, topic: c.topic })), sections: [], modelUsed: result.modelUsed, canceled: true },
      meta: { agent: 'grant_writer', cached: false, canceled: true, modelCalls: result.modelUsed ? 1 : 0, durationMs: result.durationMs },
    }
  }

  const answer = result.answer
  if (answer && result.modelUsed) cachePut(idea, answer, 'grant_writer', GRANT_NAMESPACE)

  emit?.({ type: 'final', answer, agent: 'grant_writer', cached: false, modelUsed: result.modelUsed, durationMs: result.durationMs })

  return {
    answer,
    sources: result.context.slice(0, 8).map(c => ({ title: c.title, year: c.year, url: c.url })),
    draft: {
      idea,
      papers: result.context.map(c => ({ title: c.title, year: c.year, url: c.url, first_author: c.first_author, topic: c.topic })),
      sections: result.sections,
      modelUsed: result.modelUsed,
    },
    meta: { agent: 'grant_writer', cached: false, modelCalls: result.modelUsed ? 1 : 0, durationMs: result.durationMs },
  }
}
