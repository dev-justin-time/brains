// ADA Infrastructure Agents — the 5 meta-capabilities, ported from the Python
// backend (agents/infrastructure.py) and wired into the Node/Blocks stack:
//
//   - securitySweep    prompt-injection + PII scan (Sentinel)
//   - factCheck        retraction / validity check for a DOI
//   - harvestPapers    arXiv scrape for recent papers (reuses blocks/lib/arxiv.js)
//   - discoverBridges  betweenness-centrality bridge papers (reuses the
//                      star-map graph load + Brandes, matching graph_explorer)
//   - dataAdvise       DB scaling / vector-index recommendations

import { arxivQuery, buildTopicQuery } from '../blocks/lib/arxiv.js'
import { loadGraph, buildIndex } from '../blocks/lib/graphexplorer.js'

// ---------- Sentinel: prompt injection + PII ----------

// Injection patterns are scoped to INSTRUCTION-style matches so legitimate
// research questions (e.g. "how do agents defend against system-prompt
// attacks?") are not blocked: /system prompt/ and /you are now/ only count
// when an imperative verb appears near them.
const INJECTION_PATTERNS = [
  /ignore previous instructions/,
  /\b(reveal|print|show|output|expose|leak|ignore|disregard|bypass|override|forget|disclose)\b[^.!\n]{0,40}\bsystem prompt\b/i,
  /\byou are now\b[^.!\n]{0,30}\b(reveal|tell|say|act|pretend|behave|become)\b/i,
  /\[INST\]/,
  /<\|im_start\|>/,
]
const PII_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\b\d{3}-\d{2}-\d{4}\b/, // US SSN
]

export function securitySweep(text) {
  const hay = String(text || '')
  const threats = []
  for (const p of INJECTION_PATTERNS) {
    if (p.test(hay)) threats.push(`PROMPT_INJECTION: ${p.source}`)
  }
  for (const p of PII_PATTERNS) {
    if (p.test(hay)) threats.push(`PII_LEAK: ${p.source}`)
  }
  return { is_safe: threats.length === 0, threats }
}

// ---------- Fact checker: retraction / validity ----------

const RETRACTED_DOIS = new Set(['10.1126/science.aee']) // known retracted prefix (mock corpus)

export function factCheck(doi) {
  const d = String(doi || '').toLowerCase()
  if (!d) return { status: 'UNKNOWN', warning: 'No DOI provided — nothing to verify.' }
  if (d.includes('retracted') || [...RETRACTED_DOIS].some(p => d.includes(p))) {
    return { status: 'RETRACTED', warning: '⚠️ WARNING: This paper has been retracted or failed replication.' }
  }
  return { status: 'VALID', warning: null }
}

// ---------- Paper agent: harvest from arXiv ----------

/**
 * Scrape arXiv for the newest papers on a topic and map them to the ADA card
 * shape ({ id, title, authors, year, abstract, url, domain }).
 * @param {string} topic
 * @param {number} [maxResults]
 * @param {{ fetcher?: (opts:any)=>Promise<any[]> }} [opts] test hook for an injected fetcher
 */
export async function harvestPapers(topic, maxResults = 5, { fetcher } = {}) {
  const query = buildTopicQuery(topic)
  const entries = fetcher
    ? await fetcher({ query, maxResults, start: 0 })
    : await arxivQuery({ query, maxResults, start: 0 })
  return entries.map(r => ({
    id: r.arxivId || r.id,
    title: r.title,
    authors: r.authors,
    year: r.published ? new Date(r.published).getFullYear() : null,
    abstract: r.summary,
    url: r.url,
    domain: 'Auto-Harvested',
  }))
}

// ---------- Discovery agent: bridge papers (betweenness) ----------

// Brandes betweenness on the star-map graph (215 nodes, ~700 edges — fast).
// Mirrors the algorithm used by graph_explorer so both agents agree.
function brandesBetweenness(index) {
  const score = new Map(index.nodes.map(n => [n.id, 0]))
  for (const s of index.nodes) {
    const stack = []
    const preds = new Map()
    const sigma = new Map(index.nodes.map(n => [n.id, 0]))
    const dist = new Map(index.nodes.map(n => [n.id, -1]))
    sigma.set(s.id, 1)
    dist.set(s.id, 0)
    const queue = [s.id]
    while (queue.length) {
      const v = queue.shift()
      stack.push(v)
      for (const w of index.adj.get(v)) {
        if (dist.get(w) < 0) {
          dist.set(w, dist.get(v) + 1)
          queue.push(w)
        }
        if (dist.get(w) === dist.get(v) + 1) {
          sigma.set(w, sigma.get(w) + sigma.get(v))
          if (!preds.has(w)) preds.set(w, [])
          preds.get(w).push(v)
        }
      }
    }
    const delta = new Map(index.nodes.map(n => [n.id, 0]))
    while (stack.length) {
      const w = stack.pop()
      for (const v of preds.get(w) || []) {
        delta.set(v, delta.get(v) + (sigma.get(v) / sigma.get(w)) * (1 + delta.get(w)))
      }
      if (w !== s.id) score.set(w, score.get(w) + delta.get(w))
    }
  }
  return score
}

/**
 * Find the top bridge papers — nodes with the highest betweenness centrality,
 * i.e. the interdisciplinary hubs linking otherwise-separate clusters.
 * @param {number} [top]
 */
export function discoverBridges(top = 3) {
  const graph = loadGraph()
  if (!graph) {
    return { bridges: [], error: 'star-map graph unavailable (public/graph_data.json missing)' }
  }
  const index = { graph, ...buildIndex(graph) }
  const bc = brandesBetweenness(index)
  const ranked = [...bc.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
  return {
    bridges: ranked.map(([id, score]) => {
      const n = index.byId.get(id)
      return {
        node_id: id,
        title: n.title,
        bridge_score: Math.round(score * 10000) / 10000,
        action: 'Highlight as Interdisciplinary Hub',
      }
    }),
  }
}

// ---------- Data agent: scaling advice ----------

export function dataAdvise(dbMetrics = {}) {
  if ((dbMetrics.vector_count || 0) > 100000) {
    return 'Recommendation: Migrate to HNSW indexing with ef_construction=200. Consider sharding metadata to Postgres.'
  }
  return 'Database health optimal for current scale.'
}
