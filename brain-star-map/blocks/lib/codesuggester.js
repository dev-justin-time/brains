// code_suggester — turn a paper's method / research idea into a PyTorch
// architecture skeleton.
//
// Retrieves the most relevant corpus papers (multi-hop, like lit_review) and an
// LLM sketches a PyTorch model skeleton grounded in them:
//
//   ## ARCHITECTURE OVERVIEW
//   ## PYTORCH SKELETON      (a model class + forward — a SKELETON, not verified code)
//   ## DATA & PREPROCESSING
//   ## TRAINING & EVALUATION
//   ## LIMITATIONS
//
// HONESTY GUARDRAIL: the roadmap flagged code generation as hallucination-prone.
// The prompt is pinned to an architecture OUTLINE — a starting skeleton with
// the shape of the cited methods — and explicitly told not to fabricate APIs,
// imports beyond torch basics, or claim the code runs. The skeleton.json
// artifact carries the cited papers so the user can check the real method.
//
// Artifacts: answer (text/plain), sources (application/json), skeleton
// (application/json — idea, papers, parsed sections).

import { chat, chatStream, hasModel, systemMessage, userMessage, CHAT_MODEL } from '../../server/ollama.js'
import { cacheGet, cachePut } from '../../server/db.js'
import { extractQuestion } from './engine.js'
import { multiHopRetrieve, collectSections } from './litreview.js'

export const CODE_NAMESPACE = 'code_suggester'

const CODE_PROMPT = `You are the Code Suggester agent for a corpus of real arXiv papers about brain technology (BCI, EEG, neural decoding, connectomics, deep learning).

The caller wants a PYTORCH ARCHITECTURE SKELETON for a method or research idea. Retrieve design choices ONLY from the CONTEXT block below (real paper abstracts) and cite them as [n].

Write EXACTLY these five markdown sections:

## ARCHITECTURE OVERVIEW
2-4 sentences: the model family and the key design choices from the cited papers (e.g. temporal convolutions, attention, Riemannian layers), each choice citing [n].

## PYTORCH SKELETON
A fenced \`\`\`python code block with a single nn.Module skeleton: __init__ signature + forward, with inline comments where the cited papers' design choices plug in. Keep it a SKELETON — placeholder dimensions, no training loop, torch-only imports.

## DATA & PREPROCESSING
1-3 lines on the data pipeline shape (windowed trials, band-pass filtering, channel layout) grounded in the CONTEXT, citing [n].

## TRAINING & EVALUATION
1-3 lines: sensible training choices and the evaluation protocol used by the cited papers (e.g. cross-subject CV), citing [n].

## LIMITATIONS
1-2 honest lines: this is an unverified skeleton; the real method details live in the cited papers.

RULES:
1. Never invent papers, architectures, or numbers — cite only [n] entries present in CONTEXT.
2. The code is an UNVERIFIED SKELETON: no fabricated imports beyond torch basics (torch, torch.nn, torch.nn.functional), no claims that it runs, no API names the CONTEXT does not support.
3. Keep the skeleton compact (under ~50 lines).
4. Do not add sections beyond the five listed.`

export async function answerCodeQuestion(idea, { signal, onToken, forceNoModel = false } = {}) {
  const t0 = Date.now()
  const context = await multiHopRetrieve(idea, { topGlobal: 6, topPerTopic: 4, max: 10 })
  const ctxBlock = context.map((r, i) =>
    `[${i + 1}] ${r.title} (${r.first_author}, ${r.year}) — topic: ${r.topic}\n${r.snippet}`
  ).join('\n\n')

  const prompt = CODE_PROMPT + `\n\nMETHOD / IDEA:\n${idea}\n\nCONTEXT:\n${ctxBlock || '(no matching papers found in the corpus)'}`
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
      '## ARCHITECTURE OVERVIEW',
      `The corpus contains ${context.length} paper(s) relevant to "${idea}". The language model is unavailable, so this is a retrieval-only skeleton.`,
      '',
      '## PYTORCH SKELETON',
      '```python\n# Retrieval-only mode: run again when the synthesis model is available.\n```',
      '',
      '## DATA & PREPROCESSING',
      context.length ? lines.map(l => `- ${l}`).join('\n') : '- (no matching papers)',
      '',
      '## TRAINING & EVALUATION',
      'See the ranked papers above for the evaluation protocols used by the source methods.',
      '',
      '## LIMITATIONS',
      'Without a synthesis model the skeleton cannot be drafted — verify the method in the cited papers.',
    ].join('\n')
  }

  const sections = collectSections(text)
  return { answer: text.trim(), sections, context, modelUsed, durationMs: Date.now() - t0 }
}

export async function runCodeSuggester(task, ctx, emit) {
  const idea = extractQuestion(task)

  const cached = cacheGet(idea, CODE_NAMESPACE)
  if (cached) {
    emit?.({ type: 'status', message: `Answered from cache (popular question, ${cached.hits} total hits)` })
    const context = await multiHopRetrieve(idea)
    const sections = collectSections(cached.answer)
    return {
      answer: cached.answer,
      sources: context.slice(0, 8).map(c => ({ title: c.title, year: c.year, url: c.url })),
      skeleton: { idea, papers: context.map(c => ({ title: c.title, year: c.year, url: c.url, first_author: c.first_author, topic: c.topic })), sections, modelUsed: true, cached: true },
      meta: { agent: 'code_suggester', cached: true, modelCalls: 0, durationMs: 0 },
    }
  }

  emit?.({ type: 'status', message: `code_suggester: retrieving methods for "${idea.slice(0, 80)}"…` })
  const t0 = Date.now()

  let result
  try {
    result = await answerCodeQuestion(idea, {
      signal: ctx?.cancelSignal,
      onToken: t => emit?.({ type: 'token', text: t }),
    })
  } catch (err) {
    if (err?.name === 'AbortError' || ctx?.cancelSignal?.aborted || ctx?.isCancelled) {
      emit?.({ type: 'status', message: 'Task canceled — returning partial output.' })
      return {
        answer: '(Task was canceled before the skeleton was completed.)',
        sources: [],
        skeleton: { idea, papers: [], sections: [], modelUsed: false, canceled: true },
        meta: { agent: 'code_suggester', cached: false, canceled: true, modelCalls: 0, durationMs: Date.now() - t0 },
      }
    }
    throw err
  }

  if (result.partial) {
    emit?.({ type: 'status', message: 'Task canceled — returning partial output.' })
    return {
      answer: result.answer.trim() || '(Task was canceled before the skeleton was completed.)',
      sources: result.context.slice(0, 8).map(c => ({ title: c.title, year: c.year, url: c.url })),
      skeleton: { idea, papers: result.context.map(c => ({ title: c.title, year: c.year, url: c.url, first_author: c.first_author, topic: c.topic })), sections: [], modelUsed: result.modelUsed, canceled: true },
      meta: { agent: 'code_suggester', cached: false, canceled: true, modelCalls: result.modelUsed ? 1 : 0, durationMs: result.durationMs },
    }
  }

  const answer = result.answer
  if (answer && result.modelUsed) cachePut(idea, answer, 'code_suggester', CODE_NAMESPACE)

  emit?.({ type: 'final', answer, agent: 'code_suggester', cached: false, modelUsed: result.modelUsed, durationMs: result.durationMs })

  return {
    answer,
    sources: result.context.slice(0, 8).map(c => ({ title: c.title, year: c.year, url: c.url })),
    skeleton: {
      idea,
      papers: result.context.map(c => ({ title: c.title, year: c.year, url: c.url, first_author: c.first_author, topic: c.topic })),
      sections: result.sections,
      modelUsed: result.modelUsed,
    },
    meta: { agent: 'code_suggester', cached: false, modelCalls: result.modelUsed ? 1 : 0, durationMs: result.durationMs },
  }
}
