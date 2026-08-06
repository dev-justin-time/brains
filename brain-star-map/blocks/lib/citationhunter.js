// citation_hunter — "who cites X / what does X build on?" over the star-map.
//
// LLM-free (like graph_explorer / sota_tracker): answers citation-style
// questions from the star-map graph (public/graph_data.json).
//
// HONESTY GUARDRAIL: the star-map edges are a KEYWORD-CO-OCCURRENCE PROXY, not
// a verified citation graph (real citation edges from Semantic Scholar are not
// ingested yet). Every answer says so and frames its numbers as "connections"
// / relatedness, never as true citation counts. This mirrors the same
// disclaimer the web UI shows ("Edges: keyword co-occurrence proxy").
//
// Intents:
//   - "most cited / citation leaders / most connected"   -> top-degree ranking
//   - "who cites X / related to X / builds on X"         -> X's 1-hop neighbors
//   - "citation count of X / how cited is X"             -> X's degree
//
// Artifacts: answer (text/plain) + sources (application/json).

import { loadGraph, buildIndex } from './graphexplorer.js'
import { extractQuestion } from './engine.js'

const PROXY_NOTE =
  'NOTE: star-map edges are a keyword-co-occurrence proxy for citations, not a verified citation graph — treat these as relatedness signals, not citation counts.'

// ---------- question parsing (mirrors graph_explorer) ----------

function normalize(q) {
  return q.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim()
}

function topicFilter(normalizedQ, index) {
  const labels = [...new Set(index.nodes.map(n => n.community_label))]
  for (const label of labels) {
    if (normalizedQ.includes(label.toLowerCase())) return n => n.community_label === label
  }
  return null
}

const STOP_TOKENS = new Set([
  'cites', 'cite', 'cited', 'citations', 'citation', 'papers', 'paper', 'who',
  'what', 'which', 'most', 'top', 'related', 'connected', 'builds', 'build',
  'on', 'around', 'the', 'of', 'in', 'for', 'and', 'with', 'is', 'are', 'about',
  'show', 'list', 'network', 'graph',
  // Count-question filler (keeps the title lookup clean after the "count" intent)
  'does', 'how', 'many', 'have', 'has', 'total', 'count', 'number',
])

// Find a paper by id or title within the graph (title match via token overlap
// weighted by token length — good enough for a citation-style lookup).
function findPaper(normalizedQ, index) {
  const qCompact = normalizedQ.replace(/\s+/g, '')
  for (const n of index.nodes) {
    const nid = (n.id || '').toLowerCase().replace(/\s+/g, '')
    if (nid && qCompact.includes(nid)) return n
  }
  const tokens = normalizedQ.split(' ').filter(t => t.length >= 4 && !STOP_TOKENS.has(t))
  if (!tokens.length) return null
  let best = null
  let bestScore = 0
  for (const n of index.nodes) {
    const t = n.title.toLowerCase()
    let score = 0
    for (const tok of tokens) {
      if (t.includes(tok)) score += tok.length
    }
    if (score > bestScore) { bestScore = score; best = n }
  }
  return bestScore > 0 ? best : null
}

// ---------- answer ----------

export function answerCitationQuestion(question) {
  const graph = loadGraph()
  if (!graph) {
    return { answer: 'The star-map graph is not available right now (public/graph_data.json missing).', sources: [] }
  }
  const index = buildIndex(graph)
  const q = normalize(question)

  // Intent 1: citation leaders / most cited (optionally per topic).
  if (/(most\s*cited|citation\s*leaders|top\s*(?:cited|citations)|most\s*(?:referenced|connected|linked)|citation\s*counts|hubs)/.test(q)) {
    const filter = topicFilter(q, index)
    const list = index.nodes
      .filter(filter || (() => true))
      .map(n => ({ node: n, neighbors: index.adj.get(n.id).length }))
      .sort((a, b) => b.neighbors - a.neighbors || (b.node.degree || 0) - (a.node.degree || 0))
      .slice(0, 10)
    const header = filter
      ? `Top ${list.length} papers in ${list[0]?.node.community_label || 'the corpus'} by proxy connections (degree):`
      : `Top ${list.length} papers by proxy connections (degree):`
    return {
      answer: `${PROXY_NOTE}\n\n${header}\n` +
        list.map((r, i) => `${i + 1}. ${r.node.title} — ${r.neighbors} connections, ${r.node.degree} weighted (${r.node.community_label})`).join('\n'),
      sources: list.map(r => ({ title: r.node.title, year: r.node.year, url: r.node.url })),
    }
  }

  // Intent 2: who cites / related to / builds on a specific paper.
  if (/(cite|cited|citation|related|connected|builds|build|influenced|references|works\s+with)/.test(q)) {
    const paper = findPaper(q, index)
    if (paper) {
      const neighbors = index.adj.get(paper.id)
        .map(id => index.byId.get(id))
        .sort((a, b) => index.adj.get(b.id).length - index.adj.get(a.id).length)
      const lines = neighbors.map((n, i) => `${i + 1}. ${n.title} — ${index.adj.get(n.id).length} connections (${n.community_label})`)
      return {
        answer:
          `${PROXY_NOTE}\n\nPapers most related to "${paper.title}" (${paper.community_label}): ` +
          `${neighbors.length} paper(s) share keyword co-occurrence with it.\n` + lines.join('\n'),
        sources: neighbors.map(n => ({ title: n.title, year: n.year, url: n.url })),
      }
    }
    return {
      answer: `${PROXY_NOTE}\n\nCould not find that paper in the star-map. Try a paper title from the corpus, or ask "most cited papers in Connectomics".`,
      sources: [],
    }
  }

  // Intent 3: citation count of a paper. Word-bounded so "connections"
  // doesn't leave stray junk in the capture, and filler tokens are filtered
  // by findPaper's STOP_TOKENS.
  const countMatch = /(citation|connections?|degree)\b[\s:]*(?:count|number)?[\s:]*(?:of|for)?[\s:]+(.+)/.exec(q)
  if (countMatch) {
    const paper = findPaper(countMatch[2] || q, index)
    if (paper) {
      const n = index.adj.get(paper.id).length
      return {
        answer: `${PROXY_NOTE}\n\n"${paper.title}" has ${n} direct connection(s) in the star-map (weighted degree ${paper.degree}).`,
        sources: [{ title: paper.title, year: paper.year, url: paper.url }],
      }
    }
  }

  return {
    answer:
      `${PROXY_NOTE}\n\nI can answer citation-style questions over the star-map (keyword-proxy):\n` +
      '  - "Most cited papers in Connectomics"\n  - "Who cites <paper title>?"\n  - "How many connections does <paper> have?"',
    sources: [],
  }
}

// ---------- handler ----------

export async function runCitationHunter(task, ctx) {
  const question = extractQuestion(task)

  ctx?.reportStatus('citation_hunter: tracing proxy citations over the star-map (no LLM)…')

  const { answer, sources } = answerCitationQuestion(question)

  const artifacts = [{ data: answer, mimeType: 'text/plain', outputId: 'answer' }]
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
