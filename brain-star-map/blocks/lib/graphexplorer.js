// graph_explorer — the star-map as an agent.
//
// LLM-free (like star_map_demo / sota_tracker): it reasons directly over the
// citation star-map graph (public/graph_data.json — the same data the 3D
// visualization renders), so every call is instant and costs zero model tokens.
//
// Query intents (parsed from the question):
//   - "most central / top / important / hub papers in <topic>" -> degree
//     centrality ranking, optionally filtered to a community/topic
//   - "neighbors / related / connected / around <paper>"        -> 1-hop subgraph
//   - "communities / clusters / topics"                          -> community overview
//   - "path / between / shortest <paperA> and <paperB>"          -> BFS shortest path
//   - "bridge / broker / betweenness"                            -> top bridge nodes
//
// Artifacts:
//   - answer    text/plain       the graph answer (rankings, subgraphs, paths)
//   - subgraph  application/json when a subgraph/path is returned: { nodes, links }
//               in the same shape as graph_data.json, so callers can visualize it
//   - sources   application/json the papers involved (title, year, url)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { search } from '../../server/search.js'
import { extractQuestion } from './engine.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GRAPH_PATH = path.join(__dirname, '..', '..', 'public', 'graph_data.json')

// ---------- graph loading ----------

export function loadGraph() {
  if (!fs.existsSync(GRAPH_PATH)) return null
  try {
    return JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'))
  } catch {
    return null
  }
}

function buildIndex(graph) {
  const nodes = graph.nodes
  const byId = new Map(nodes.map(n => [n.id, n]))
  const adj = new Map(nodes.map(n => [n.id, []]))
  for (const e of graph.links) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue
    adj.get(e.source).push(e.target)
    adj.get(e.target).push(e.source)
  }
  return { nodes, byId, adj }
}

// ---------- graph algorithms ----------

// Degree centrality = number of distinct neighbors (1-hop). The corpus also
// stores a weighted `degree` (sum of shared-keyword weights) — we report the
// unweighted neighbor count here and keep the weighted one as a secondary signal.
function degreeRanking(index, filter) {
  return index.nodes
    .filter(filter)
    .map(n => ({ node: n, neighbors: index.adj.get(n.id).length }))
    .sort((a, b) => b.neighbors - a.neighbors || (b.node.degree || 0) - (a.node.degree || 0))
}

function oneHopSubgraph(index, id, { maxNeighbors = 40 } = {}) {
  const node = index.byId.get(id)
  if (!node) return null
  const neighbors = index.adj.get(id).slice(0, maxNeighbors)
  const ids = new Set([id, ...neighbors])
  const links = graphLinksBetween(index, id, neighbors)
  return {
    root: node,
    nodes: [node, ...neighbors.map(n => index.byId.get(n))],
    neighbors: neighbors.map(n => index.byId.get(n)),
    links,
  }
}

function graphLinksBetween(index, rootId, neighborIds) {
  const graph = index.graph
  const set = new Set([rootId, ...neighborIds])
  return graph.links.filter(e => set.has(e.source) && set.has(e.target))
}

function bfsPath(index, startId, goalId) {
  const prev = new Map()
  const visited = new Set([startId])
  const queue = [startId]
  while (queue.length) {
    const cur = queue.shift()
    if (cur === goalId) break
    for (const nxt of index.adj.get(cur)) {
      if (visited.has(nxt)) continue
      visited.add(nxt)
      prev.set(nxt, cur)
      queue.push(nxt)
    }
  }
  if (!prev.has(goalId) && startId !== goalId) return null
  const path = [goalId]
  let cur = goalId
  while (cur !== startId) {
    cur = prev.get(cur)
    path.unshift(cur)
  }
  return path
}

// Betweenness via Brandes on a small graph (215 nodes, 700 edges — fast).
function betweenness(index) {
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

// ---------- question parsing ----------

function normalize(q) {
  return q.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim()
}

function topicFilter(normalizedQ, index) {
  // Match a community label or a topic keyword against the question.
  const labels = [...new Set(index.nodes.map(n => n.community_label))]
  for (const label of labels) {
    if (normalizedQ.includes(label.toLowerCase())) {
      return n => n.community_label === label
    }
  }
  // Try topic keywords from node.topic.
  const topics = new Set(index.nodes.map(n => n.topic).filter(Boolean))
  for (const t of topics) {
    if (normalizedQ.includes(t.toLowerCase())) {
      return n => n.topic === t
    }
  }
  return null
}

// Words that are graph-structure markers or filler — never part of a paper title.
const STOP_TOKENS = new Set([
  'subgraph', 'neighbor', 'neighbors', 'related', 'connected', 'around', 'about',
  'near', 'close', 'paper', 'papers', 'show', 'list', 'between', 'and', 'for',
  'from', 'with', 'the', 'of', 'in', 'on', 'to', 'a', 'an', 'what', 'is', 'are',
])

// Strip graph-structure words + filler so the remaining text is a title lookup.
function cleanTitleQuery(normalizedQ) {
  return normalizedQ
    .split(' ')
    .filter(t => t && !STOP_TOKENS.has(t))
    .join(' ')
}

// Find a paper by id or title. Ids match first (dot-normalized so "2607.03094v1"
// matches "2607 03094v1" after normalize()); then the existing hybrid search()
// is reused for title lookup (far more robust than hand-rolled token counting);
// finally a distinctive-token fallback for when the DB index is unavailable.
function findPaper(normalizedQ, index) {
  // 1. Exact id (normalize dots/spaces on both sides).
  const qCompact = normalizedQ.replace(/\s+/g, '')
  for (const n of index.nodes) {
    const nid = (n.id || '').toLowerCase().replace(/\s+/g, '')
    if (nid && qCompact.includes(nid)) return n
  }

  // 2. Reuse the corpus hybrid retrieval for title matching.
  const titleQ = cleanTitleQuery(normalizedQ)
  if (titleQ.length >= 4) {
    try {
      const hits = search(titleQ, { topK: 3 })
      for (const h of hits) {
        const n = index.byId.get(h.id)
        if (!n) continue
        const title = n.title.toLowerCase()
        // Require at least one distinctive token actually present in the title.
        const distinctive = titleQ.split(' ').filter(t => t.length >= 4 && !STOP_TOKENS.has(t))
        if (distinctive.some(t => title.includes(t))) return n
      }
    } catch { /* DB index unavailable — fall through to token matching */ }
  }

  // 3. Fallback: distinctive-token counting, weighted by token length (longer =
  // more distinctive), so "artemis" beats the generic "subgraph" on ties.
  const titleTokens = normalizedQ.split(' ').filter(t => t.length >= 4 && !STOP_TOKENS.has(t))
  if (!titleTokens.length) return null
  let best = null
  let bestScore = 0
  for (const n of index.nodes) {
    const t = n.title.toLowerCase()
    let score = 0
    for (const tok of titleTokens) {
      if (t.includes(tok)) score += tok.length
    }
    if (score > bestScore) {
      bestScore = score
      best = n
    }
  }
  return bestScore > 0 ? best : null
}

// ---------- answer ----------

export function answerGraphQuestion(question) {
  const graph = loadGraph()
  if (!graph) {
    return { answer: 'The star-map graph is not available right now (public/graph_data.json missing).', sources: [], subgraph: null }
  }
  const index = { graph, ...buildIndex(graph) }
  const q = normalize(question)

  // Intent 1: central papers / hubs (optionally in a topic).
  if (/(most|top|central|important|hub|key|highest|leading)/.test(q) && /(paper|papers|node|nodes|article)/.test(q)) {
    const filter = topicFilter(q, index)
    const list = degreeRanking(index, filter || (() => true)).slice(0, 10)
    const header = filter
      ? `Top ${list.length} most central papers in ${list[0]?.node.community_label || 'the corpus'} (by neighbor count):`
      : `Top ${list.length} most central papers in the corpus (by neighbor count):`
    return {
      answer: header + '\n' + list.map((r, i) => `${i + 1}. ${r.node.title} — ${r.neighbors} neighbors, ${r.node.degree} weighted (${r.node.community_label})`).join('\n'),
      sources: list.map(r => ({ title: r.node.title, year: r.node.year, url: r.node.url })),
      subgraph: null,
    }
  }

  // Intent 2: communities / clusters.
  if (/(community|communities|cluster|topic areas|landscape|structure)/.test(q) && !/paper|node/.test(q)) {
    const counts = {}
    for (const n of index.nodes) counts[n.community_label] = (counts[n.community_label] || 0) + 1
    const lines = Object.entries(counts).sort((a, b) => b[1] - a[1])
      .map(([label, count]) => `- ${label}: ${count} papers (${Math.round(count / index.nodes.length * 100)}%)`)
    return {
      answer: `The citation star-map has ${index.nodes.length} papers connected by ${graph.links.length} keyword-co-occurrence edges across ${lines.length} communities:\n` + lines.join('\n'),
      sources: [],
      subgraph: null,
    }
  }

  // Intent 3: bridge / betweenness.
  if (/(bridge|broker|betweenness|connector|gateway)/.test(q)) {
    const bc = betweenness(index)
    const ranked = [...bc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    const lines = ranked.map(([id, score], i) => {
      const n = index.byId.get(id)
      return `${i + 1}. ${n.title} — betweenness ${score.toFixed(3)} (${n.community_label})`
    })
    return {
      answer: 'Top bridge papers (highest betweenness centrality — they link otherwise-separate research clusters):\n' + lines.join('\n'),
      sources: ranked.map(([id]) => { const n = index.byId.get(id); return { title: n.title, year: n.year, url: n.url } }),
      subgraph: null,
    }
  }

  // Intent 4: shortest path between two papers.
  if (/(path|between|shortest|connect)/.test(q)) {
    const m = q.match(/(.+?)\s+(?:and|to|from)\s+(.+)/)
    if (m) {
      const a = findPaper(m[1], index)
      const b = findPaper(m[2], index)
      if (a && b && a.id !== b.id) {
        const path = bfsPath(index, a.id, b.id)
        if (path) {
          const lines = path.map(id => index.byId.get(id).title)
          const subgraph = {
            root: a,
            nodes: path.map(id => index.byId.get(id)),
            links: graphLinksBetween(index, a.id, path.slice(1)),
          }
          return {
            answer: `Shortest path (${path.length - 1} edge${path.length - 1 === 1 ? '' : 's'}) between:\n  A. ${a.title}\n  B. ${b.title}\n\n${lines.map((t, i) => `${i}. ${t}`).join('\n')}`,
            sources: [a, b].map(n => ({ title: n.title, year: n.year, url: n.url })),
            subgraph,
          }
        }
        return {
          answer: `No path connects "${a.title}" to "${b.title}" in the current star-map (keyword-co-occurrence edges only).`,
          sources: [a, b].map(n => ({ title: n.title, year: n.year, url: n.url })),
          subgraph: null,
        }
      }
    }
  }

  // Intent 5: neighbors / subgraph around a paper. Fires only when the query
  // actually asks for graph structure — NOT as a catch-all (so "What is
  // connectomics?" doesn't return a random paper's subgraph).
  if (/(neighbor|related|connected|around|subgraph|near|close)/.test(q)) {
    const paper = findPaper(q, index)
    if (paper) {
      const sub = oneHopSubgraph(index, paper.id)
      const lines = sub.neighbors.map((n, i) => `${i + 1}. ${n.title} — ${index.adj.get(n.id).length} neighbors (${n.community_label})`)
      const subgraph = {
        root: paper,
        nodes: sub.nodes.map(n => ({ id: n.id, title: n.title, year: n.year, url: n.url, community_label: n.community_label })),
        links: sub.links,
      }
      return {
        answer: `Subgraph around "${paper.title}" (${paper.community_label}): ${sub.neighbors.length} directly connected paper(s).\n` + lines.join('\n'),
        sources: sub.neighbors.map(n => ({ title: n.title, year: n.year, url: n.url })),
        subgraph,
      }
    }
  }

  // Fallback: keyword search of titles, then neighborhoods.
  const kw = q.split(' ').filter(t => t.length > 3)
  const hits = index.nodes.filter(n => {
    const t = n.title.toLowerCase()
    return kw.some(k => t.includes(k))
  }).slice(0, 5)
  if (hits.length) {
    return {
      answer: `Papers matching "${question}":\n` + hits.map((n, i) => `${i + 1}. ${n.title} (${n.first_author}, ${n.year}) — ${n.community_label}`).join('\n') +
        `\n\nAsk "subgraph around <paper>" or "most central papers in <topic>" for graph structure.`,
      sources: hits.map(n => ({ title: n.title, year: n.year, url: n.url })),
      subgraph: null,
    }
  }

  return {
    answer: 'I can answer graph questions about the star-map corpus (215 papers, 700 edges):\n' +
      '  - "Most central papers in Connectomics"\n  - "Subgraph around <paper title>"\n' +
      '  - "Shortest path between <paper A> and <paper B>"\n  - "Bridge papers" / "communities"',
    sources: [],
    subgraph: null,
  }
}

// ---------- handler ----------

export async function runGraphExplorer(task, ctx) {
  const question = extractQuestion(task)

  ctx?.reportStatus('graph_explorer: reasoning over the star-map graph (no LLM)…')

  const { answer, sources, subgraph } = answerGraphQuestion(question)

  const artifacts = [{ data: answer, mimeType: 'text/plain', outputId: 'answer' }]
  if (subgraph) {
    artifacts.push({
      data: JSON.stringify(subgraph, null, 2),
      mimeType: 'application/json',
      outputId: 'subgraph',
      fileName: 'subgraph.json',
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
