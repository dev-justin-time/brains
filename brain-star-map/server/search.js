// Hybrid retrieval over the papers corpus.
// Combines lightweight keyword scoring (no FTS dependency) with embedding cosine similarity
// when embeddings are available. Falls back gracefully to keyword-only.
import { allPapers, allEmbeddings, getMeta } from './db.js'

let papers = []
let paperById = new Map()
let embeddings = []          // [{ paperId, vector }]
let vectorDim = 0
let loaded = false

export function loadIndex() {
  papers = allPapers()
  paperById = new Map(papers.map(p => [p.id, p]))
  embeddings = allEmbeddings()
  vectorDim = embeddings[0]?.vector.length || 0
  loaded = true
}

export function indexStats() {
  return { papers: papers.length, vectorDim, embedded: embeddings.length }
}

export function indexLoaded() {
  return loaded
}

// ---------- tokenization ----------

export function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
}

// ---------- keyword scoring ----------

function keywordScore(query, paper) {
  const qTokens = tokenize(query)
  if (!qTokens.length) return 0
  const title = (paper.title || '').toLowerCase()
  const abs = (paper.abstract || '').toLowerCase()
  const kws = (paper.keywords || []).map(k => k.toLowerCase())

  let score = 0
  for (const t of qTokens) {
    if (title.includes(t)) score += 3
    if (kws.some(k => k.includes(t))) score += 2
    if (abs.includes(t)) score += 1
  }
  // Phrase bonus: exact multi-word phrases from the query
  const words = qTokens
  for (let n = 2; n <= Math.min(4, words.length); n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(' ')
      if (title.includes(phrase)) score += 5
      else if (abs.includes(phrase)) score += 2
    }
  }
  return score
}

// ---------- vector similarity ----------

export function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ---------- snippet ----------

function makeSnippet(abstract, query, maxLen = 260) {
  const a = abstract || ''
  if (!a) return ''
  const q = query.toLowerCase()
  let idx = a.toLowerCase().indexOf(q.slice(0, 40))
  if (idx < 0) {
    const firstTok = tokenize(q)[0]
    idx = firstTok ? a.toLowerCase().indexOf(firstTok) : -1
  }
  if (idx < 0) return a.slice(0, maxLen) + (a.length > maxLen ? '…' : '')
  const start = Math.max(0, idx - 80)
  return (start > 0 ? '…' : '') + a.slice(start, start + maxLen) + (a.length > start + maxLen ? '…' : '')
}

// ---------- hybrid search ----------

export function search(query, { topK = 8, topic = null } = {}) {
  if (!loaded) loadIndex()
  if (!papers.length) return []

  const qEmbed = null // question embedding computed by caller via embedQuestion(); see below
  const vec = typeof query === 'string' ? null : query // allow passing a vector directly
  const q = typeof query === 'string' ? query : null

  const results = []
  let maxKw = 0
  const kwCache = new Map()

  for (const p of papers) {
    if (topic && p.community_label !== topic && p.topic !== topic) continue
    const kw = q ? keywordScore(q, p) : 0
    kwCache.set(p.id, kw)
    if (kw > maxKw) maxKw = kw
  }

  for (const p of papers) {
    if (topic && p.community_label !== topic && p.topic !== topic) continue
    const kw = kwCache.get(p.id)
    const kwNorm = maxKw > 0 ? kw / maxKw : 0

    let vecSim = 0
    if (vec) {
      const e = embeddings.find(e => e.paperId === p.id)
      if (e) vecSim = cosineSim(vec, e.vector)
    }

    // If we have both signals, blend; otherwise use whichever is present
    const hasKw = q && maxKw > 0
    const hasVec = vec && embeddings.length > 0
    let score = 0
    if (hasKw && hasVec) score = 0.45 * kwNorm + 0.55 * vecSim
    else if (hasVec) score = vecSim
    else if (hasKw) score = kwNorm

    if (score > 0.01) {
      results.push({ paper: p, kw: kwNorm, vec: vecSim, score })
    }
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, topK).map(r => ({
    id: r.paper.id,
    title: r.paper.title,
    year: r.paper.year,
    url: r.paper.url,
    first_author: r.paper.first_author,
    topic: r.paper.community_label || r.paper.topic,
    community: r.paper.community,
    keywords: r.paper.keywords || [],
    score: Math.round(r.score * 1000) / 1000,
    kwScore: Math.round(r.kw * 1000) / 1000,
    vecScore: Math.round(r.vec * 1000) / 1000,
    snippet: makeSnippet(r.paper.abstract, q || ''),
  }))
}

// Search restricted to a topic — used by expert agents
export function searchTopic(topic, query, topK = 6) {
  return search(query, { topK, topic })
}

// Direct-lookup helpers (answerable without an LLM)
export function directLookup(q) {
  // Ensure the in-memory index is loaded (directLookup can run before any search()).
  if (!loaded) loadIndex()
  const ql = q.toLowerCase()
  const tokens = tokenize(q)

  // "how many papers / total" → corpus stats
  if (/\b(how many|total|number of)\b/.test(ql) && /\b(paper|papers|node|nodes|article|articles)\b/.test(ql)) {
    return {
      kind: 'stats',
      text: `The corpus contains ${papers.length} papers across ${new Set(papers.map(p => p.community_label)).size} topic areas, connected by ${getMeta('total_edges') || '700'} keyword-co-occurrence edges.`,
    }
  }

  // "list/which papers about X" → top retrieval results, no LLM
  if (/\b(list|which|what papers|find|show|top)\b/.test(ql) && /\b(paper|papers|article|articles|work|research)\b/.test(ql)) {
    const hits = search(q, { topK: 5 })
    if (hits.length) {
      return {
        kind: 'papers',
        text: `Top ${hits.length} papers matching "${q}":\n` + hits.map((h, i) =>
          `${i + 1}. ${h.title} (${h.first_author}, ${h.year}) — ${h.url}`
        ).join('\n'),
      }
    }
    return { kind: 'empty', text: 'No papers matched that query.' }
  }

  // "who wrote / author of X" → author lookup
  if (/\b(who|author|authored|wrote)\b/.test(ql)) {
    const titleQuery = ql.replace(/\b(who|wrote|authored|the|author|of|is|paper|papers)\b/g, ' ').replace(/\s+/g, ' ').trim()
    if (titleQuery.length > 3) {
      const hits = search(titleQuery, { topK: 3 })
      if (hits.length) {
        return {
          kind: 'authors',
          text: `Papers matching "${titleQuery}":\n` + hits.map(h =>
            `• ${h.title} — ${h.first_author} et al. (${h.year})`
          ).join('\n'),
        }
      }
    }
  }

  return null
}

// Embed the question (best-effort; null if no embedding model)
export async function embedQuestion(q) {
  const { embed } = await import('./ollama.js')
  const v = await embed(q)
  return v || null
}
