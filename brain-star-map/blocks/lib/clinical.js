// clinical_translator — paper findings -> plain-language clinical practice notes.
//
// Unlocks non-researcher users: given a question about clinical brain-tech
// applications (stroke rehab, cerebral palsy, neurofeedback, prosthetics,
// therapy, pediatrics, seizure care…), it retrieves the most relevant corpus
// papers (filtered toward clinically-oriented work) and an LLM writes a
// practice note in plain language with four sections:
//
//   ## PLAIN-LANGUAGE SUMMARY
//   ## WHAT THIS MEANS FOR CLINICIANS
//   ## KEY NUMBERS
//   ## CAVEATS & LIMITATIONS
//
// Retrieval-only fallback produces the same four sections when no chat model
// is available (same pattern as the experts + lit_review).
//
// Artifacts: answer (text/plain), sources (application/json).

import { search } from '../../server/search.js'
import { chat, chatStream, hasModel, systemMessage, userMessage, CHAT_MODEL } from '../../server/ollama.js'
import { cacheGet, cachePut } from '../../server/db.js'
import { extractQuestion } from './engine.js'

export const CLINICAL_NAMESPACE = 'clinical_translator'

const CLINICAL_PROMPT = `You are the Clinical Translator agent for a corpus of real arXiv papers about brain technology (BCI, EEG, neural decoding, connectomics).

Translate research findings into a PLAIN-LANGUAGE clinical practice note. Assume the reader is a clinician or therapy practitioner, NOT a machine-learning researcher — avoid jargon or explain it in one short phrase. Cite papers as [n] using the CONTEXT numbers.

Write EXACTLY these four markdown sections:

## PLAIN-LANGUAGE SUMMARY
One short paragraph: what did these papers find, in everyday language?

## WHAT THIS MEANS FOR CLINICIANS
Concrete, actionable implications for clinical practice (stroke rehabilitation, cerebral palsy, neurofeedback, assistive devices, therapy sessions). Be practical and honest about readiness.

## KEY NUMBERS
Bullet list of the concrete numbers that matter (accuracy, improvement, session counts, R-squared, effect sizes) — ONLY numbers that actually appear in the CONTEXT, each with its [n] citation.

## CAVEATS & LIMITATIONS
What the papers themselves note as limitations, and any gaps between research and clinical use (sample sizes, calibration time, real-world conditions).

RULES:
1. Never invent papers, numbers, or clinical claims — cite only [n] entries present in CONTEXT.
2. If no clinically relevant paper matched, say so plainly.
3. Keep each section tight and readable; the whole note should read like a professional clinical summary.`

// Clinical-flavored keywords that mark a paper as practice-relevant. Papers are
// ranked by clinical keyword overlap so therapy-facing results float to the top
// even when the question itself is technical.
const CLINICAL_KEYWORDS = [
  'stroke', 'rehabilitation', 'rehab', 'cerebral palsy', 'neurofeedback',
  'prosthetic', 'prosthetics', 'therapy', 'clinical', 'patient', 'patients',
  'pediatric', 'children', 'assistive', 'motor function', 'restoration',
  'movement-related', 'calibration', 'usability', 'real-time', 'implant',
  'implantable', 'brain-machine interface', 'bmi',
]

function clinicalScore(p) {
  const text = `${p.title} ${p.abstract || ''} ${(p.keywords || []).join(' ')}`.toLowerCase()
  let s = 0
  for (const k of CLINICAL_KEYWORDS) {
    if (text.includes(k)) s++
  }
  return s
}

export async function clinicalRetrieve(question, { topK = 8 } = {}) {
  const hits = search(question, { topK: 16 })
  return hits
    .map(h => ({ ...h, clinical: clinicalScore(h) }))
    .sort((a, b) => b.clinical - a.clinical || b.score - a.score)
    .slice(0, topK)
}

export async function answerClinicalQuestion(question, { signal, onToken, forceNoModel = false } = {}) {
  const t0 = Date.now()
  const context = await clinicalRetrieve(question)
  const ctxBlock = context.map((r, i) =>
    `[${i + 1}] ${r.title} (${r.first_author}, ${r.year}) — topic: ${r.topic}\n${r.snippet}`
  ).join('\n\n')

  const prompt = CLINICAL_PROMPT + `\n\nQUESTION:\n${question}\n\nCONTEXT:\n${ctxBlock || '(no matching papers found in the corpus)'}`
  const messages = [systemMessage(prompt), userMessage(question)]

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
      '## PLAIN-LANGUAGE SUMMARY',
      `The corpus contains ${context.length} clinically relevant paper(s) for "${question}". The language model is unavailable, so this is a retrieval-based note (papers ranked by clinical relevance).`,
      '',
      '## WHAT THIS MEANS FOR CLINICIANS',
      context.length ? 'Review the ranked papers below; each is a primary source for the practical findings.' : 'No clinically relevant corpus evidence matched this question.',
      '',
      '## KEY NUMBERS',
      context.length ? lines.map(l => `- ${l}`).join('\n') : '- (none)',
      '',
      '## CAVEATS & LIMITATIONS',
      'Without a synthesis model, quantitative claims cannot be distilled — verify numbers in the linked abstracts.',
    ].join('\n')
  }

  return { answer: text.trim(), context, modelUsed, durationMs: Date.now() - t0 }
}

export async function runClinicalTranslator(task, ctx, emit) {
  const question = extractQuestion(task)

  const cached = cacheGet(question, CLINICAL_NAMESPACE)
  if (cached) {
    emit?.({ type: 'status', message: `Answered from cache (popular question, ${cached.hits} total hits)` })
    const context = await clinicalRetrieve(question)
    return {
      answer: cached.answer,
      sources: context.slice(0, 8).map(c => ({ title: c.title, year: c.year, url: c.url })),
      meta: { agent: 'clinical_translator', cached: true, modelCalls: 0, durationMs: 0 },
    }
  }

  emit?.({ type: 'status', message: `clinical_translator: finding clinically relevant papers for "${question.slice(0, 80)}"…` })
  const t0 = Date.now()

  let result
  try {
    result = await answerClinicalQuestion(question, {
      signal: ctx?.cancelSignal,
      onToken: t => emit?.({ type: 'token', text: t }),
    })
  } catch (err) {
    if (err?.name === 'AbortError' || ctx?.cancelSignal?.aborted || ctx?.isCancelled) {
      emit?.({ type: 'status', message: 'Task canceled — returning partial output.' })
      return {
        answer: '(Task was canceled before the note was completed.)',
        sources: [],
        meta: { agent: 'clinical_translator', cached: false, canceled: true, modelCalls: 0, durationMs: Date.now() - t0 },
      }
    }
    throw err
  }

  if (result.partial) {
    emit?.({ type: 'status', message: 'Task canceled — returning partial output.' })
    return {
      answer: result.answer.trim() || '(Task was canceled before the note was completed.)',
      sources: result.context.slice(0, 8).map(c => ({ title: c.title, year: c.year, url: c.url })),
      meta: { agent: 'clinical_translator', cached: false, canceled: true, modelCalls: result.modelUsed ? 1 : 0, durationMs: result.durationMs },
    }
  }

  const answer = result.answer
  if (answer && result.modelUsed) cachePut(question, answer, 'clinical_translator', CLINICAL_NAMESPACE)

  emit?.({ type: 'final', answer, agent: 'clinical_translator', cached: false, modelUsed: result.modelUsed, durationMs: result.durationMs })

  return {
    answer,
    sources: result.context.slice(0, 8).map(c => ({ title: c.title, year: c.year, url: c.url })),
    meta: { agent: 'clinical_translator', cached: false, modelCalls: result.modelUsed ? 1 : 0, durationMs: result.durationMs },
  }
}
