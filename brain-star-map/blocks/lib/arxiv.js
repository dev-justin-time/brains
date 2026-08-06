// arXiv API client for the paper_updates pipe agent.
//
// Wraps the public arXiv Atom API (https://export.arxiv.org/api/query) with a
// minimal regex-based Atom parser — no external XML dependency. Queries are
// sorted by submission date descending, so the newest papers on a topic come
// first (that is what a "what's new" stream wants).

const ARXIV_API = 'https://export.arxiv.org/api/query'
const FETCH_TIMEOUT_MS = 20000

// Grab the first <tag>...</tag> occurrence from an entry chunk.
function grab(entry, tag) {
  const m = entry.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
  return m ? m[1].trim() : null
}

export function parseAtom(xml) {
  const out = []
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g
  let m
  while ((m = entryRe.exec(xml)) !== null) {
    const e = m[1]
    const id = grab(e, 'id') || ''
    const arxivId = id.split('/abs/')[1] || id
    const title = (grab(e, 'title') || '').replace(/\s+/g, ' ').trim()
    const summary = (grab(e, 'summary') || '').replace(/\s+/g, ' ').trim()
    const published = grab(e, 'published')
    const updated = grab(e, 'updated')
    const authors = [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(a => a[1].trim())
    const cat = e.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)
    out.push({
      id,
      arxivId,
      title,
      summary,
      published,
      updated,
      authors,
      category: cat?.[1] || null,
      url: id || `https://arxiv.org/abs/${arxivId}`,
    })
  }
  return out
}

/**
 * Query the arXiv API for the newest papers matching `query`.
 *
 * @param {object} opts
 * @param {string} opts.query   search_query (e.g. `all:"motor imagery"`)
 * @param {number} [opts.maxResults=10]  page size
 * @param {number} [opts.start=0]        pagination offset
 * @param {number} [opts.timeoutMs]      fetch timeout
 * @returns {Promise<Array>} parsed entries, newest first
 */
export async function arxivQuery({ query, maxResults = 10, start = 0, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const url = `${ARXIV_API}?search_query=${encodeURIComponent(query)}&start=${start}&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`arXiv API returned ${res.status}`)
  const xml = await res.text()
  return parseAtom(xml)
}

// Build a quoted phrase search from a free-form topic ("motor imagery" ->
// all:"motor imagery"). Quoted phrases are how arXiv returns relevant recent
// hits for a topical feed.
export function buildTopicQuery(topic) {
  const t = String(topic || '').trim()
  if (!t) throw new Error('topic must not be empty')
  // Multiple comma-separated terms -> OR them so the feed is not empty.
  const terms = t.split(',').map(x => x.trim()).filter(Boolean).slice(0, 4)
  return terms.map(x => `all:"${x.replace(/"/g, '')}"`).join(' OR ')
}

// First-line snippet of an abstract for the feed event (keeps payloads light).
export function snippet(summary, maxLen = 180) {
  const s = String(summary || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
}
