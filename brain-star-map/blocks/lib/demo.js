// star_map_demo — a free demo agent for the Brain Citation Star Map project.
//
// Deliberately LLM-free: it answers corpus questions with the same
// direct-lookup / retrieval logic as the web app (zero model calls, so it can
// honestly be published free) and ALWAYS attaches the interactive 3D star-map
// page (public/demo.html) as a text/html file artifact, so any caller gets a
// downloadable copy of the demo.
//
//   - input  "question"  -> any question about the corpus, or "show the demo"
//   - output "answer"    -> text/plain response (stats, paper lists, authors)
//   - output "demo"      -> text/html file artifact with the full demo page
//
// The demo HTML is read fresh from disk on every call (small, ~24 KB).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { directLookup, search } from '../../server/search.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEMO_HTML_PATH = path.join(__dirname, '..', '..', 'public', 'demo.html')

export function demoHtml() {
  return fs.existsSync(DEMO_HTML_PATH) ? fs.readFileSync(DEMO_HTML_PATH) : null
}

// Answer without any LLM: direct lookup first (stats / lists / authors),
// then keyword retrieval as a fallback.
export function answerQuestion(question) {
  const direct = directLookup(question)
  if (direct) {
    if (direct.kind === 'stats') return { answer: direct.text, sources: [] }
    if (direct.kind === 'papers' || direct.kind === 'authors') {
      return { answer: direct.text, sources: [] }
    }
  }

  // Fallback: top corpus hits for the question, formatted without an LLM.
  const hits = search(question, { topK: 5 })
  if (hits.length) {
    const lines = hits.map((h, i) =>
      `${i + 1}. ${h.title} — ${h.first_author}, ${h.year} (${h.url})`
    )
    return {
      answer: `Top papers matching "${question}":\n\n` + lines.join('\n'),
      sources: hits.map(h => ({ title: h.title, year: h.year, url: h.url })),
    }
  }
  return {
    answer: `No corpus papers matched "${question}". Try a topic like "EEG", "connectomics", or ask "how many papers are in the corpus?".`,
    sources: [],
  }
}

export async function runStarMapDemo(task, ctx) {
  const question = (task?.requestParts?.[0]?.text ?? '').trim()
  if (!question) {
    throw new Error('Missing required input "question" — send requestParts: [{ partId: "question", text: "..." }]')
  }

  ctx?.reportStatus('star_map_demo: answering from the corpus index (no LLM)…')

  const { answer, sources } = answerQuestion(question)
  const html = demoHtml()

  const artifacts = [{ data: answer, mimeType: 'text/plain', outputId: 'answer' }]
  if (html) {
    artifacts.push({
      data: html,
      mimeType: 'text/html',
      outputId: 'demo',
      fileName: 'star-map-demo.html',
    })
  }
  if (sources.length) {
    artifacts.push({
      data: JSON.stringify(sources, null, 2),
      mimeType: 'application/json',
      outputId: 'sources',
      fileName: 'sources.json',
    })
  }
  return { artifacts }
}
