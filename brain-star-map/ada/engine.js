// ADA Protocol Engine — Analyze, Determine, Answer.
//
// Ported from the ADA Syndicate Python backend (ada_core.py):
//   - ADACache:       semantic cache keyed by MD5(query) with a 24h TTL, so
//                     repeated questions never hit the LLM twice.
//   - KnowledgeBase:  deterministic token-intersection search over the built-in
//                     knowledge_base.json ("the CSV"), grounding answers before
//                     any LLM call is allowed.
//
// The comment in the original design — "Swap for Vector DB in production" —
// is preserved in spirit: this is the deterministic grounding layer on top of
// which the persona LLM synthesis runs (blocks/lib/ada.js).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DB_PATH = path.join(__dirname, 'knowledge_base.json')

export class ADACache {
  /** @param {{ ttl?: number, cache?: Map<string,{answer:string,ts:number}> }} [opts] */
  constructor({ ttl = 86_400, cache } = {}) { // 24 hour TTL
    this.cache = cache || new Map()
    this.ttl = ttl
  }

  hash(query) {
    return createHash('md5').update(String(query || '')).digest('hex')
  }

  get(query) {
    const key = this.hash(query)
    const entry = this.cache.get(key)
    if (entry) {
      if (Date.now() - entry.ts < this.ttl * 1000) return entry.answer
      this.cache.delete(key)
    }
    return null
  }

  set(query, answer) {
    const key = this.hash(query)
    this.cache.set(key, { answer, ts: Date.now() })
  }

  get size() {
    return this.cache.size
  }
}

export class KnowledgeBase {
  /**
   * @param {string} [dbPath] path to knowledge_base.json
   */
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.data = JSON.parse(fs.readFileSync(dbPath, 'utf8'))
  }

  /**
   * Deterministic token-intersection retrieval.
   * @param {string} query
   * @param {string} [domain] filter by entry.domain ("All" = no filter)
   * @param {number} [topK]
   */
  search(query, domain = 'All', topK = 3) {
    const queryTerms = new Set(String(query || '').toLowerCase().replace(/[,.]/g, '').split(/\s+/).filter(Boolean))
    const scored = []

    for (const entry of this.data) {
      if (domain && domain !== 'All' && entry.domain !== domain) continue

      // Searchable text pool
      const text = `${entry.topic} ${entry.concept} ${entry.paper_title} ${entry.abstract}`.toLowerCase()
      const textTerms = new Set(text.split(/\s+/).filter(Boolean))

      // Simple token intersection scoring (swap for a vector DB in production).
      let score = 0
      for (const t of queryTerms) if (textTerms.has(t)) score++
      if (score > 1) scored.push({ score, entry }) // require >= 2 keyword matches
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK).map(r => r.entry)
  }
}
