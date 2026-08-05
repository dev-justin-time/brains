// SQLite data layer for the expert-agent system.
// Uses Node's built-in `node:sqlite` (zero npm dependencies).
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DB_PATH = process.env.AGENT_DB_PATH || path.join(__dirname, '..', 'data', 'agents.db')

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS papers (
    id               TEXT PRIMARY KEY,
    title            TEXT NOT NULL,
    first_author     TEXT,
    year             INTEGER,
    url              TEXT,
    published        TEXT,
    abstract         TEXT,
    keywords         TEXT,             -- JSON array
    topic            TEXT,
    community        INTEGER,
    community_label  TEXT,
    degree           INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS embeddings (
    paper_id  TEXT PRIMARY KEY REFERENCES papers(id),
    model     TEXT,
    dim       INTEGER,
    vector    BLOB                     -- float32 LE array
  );

  CREATE TABLE IF NOT EXISTS qa_cache (
    q_hash      TEXT PRIMARY KEY,
    question    TEXT NOT NULL,
    answer      TEXT NOT NULL,
    agent_id    TEXT,
    hits        INTEGER DEFAULT 1,
    created_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent  TEXT NOT NULL,
    to_agent    TEXT NOT NULL,
    question    TEXT,
    body        TEXT,
    created_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
  );
`)

// ---------- helpers ----------

const json = v => (v == null ? null : JSON.stringify(v))
const unjson = v => (v == null ? null : JSON.parse(v))

export function normalizeQuestion(q) {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function hashQuestion(q) {
  return crypto.createHash('sha256').update(normalizeQuestion(q)).digest('hex').slice(0, 32)
}

// ---------- papers ----------

const upsertPaperStmt = db.prepare(`
  INSERT INTO papers (id, title, first_author, year, url, published, abstract, keywords, topic, community, community_label, degree)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    first_author = excluded.first_author,
    year = excluded.year,
    url = excluded.url,
    published = excluded.published,
    abstract = excluded.abstract,
    keywords = excluded.keywords,
    topic = excluded.topic,
    community = excluded.community,
    community_label = excluded.community_label,
    degree = excluded.degree
`)

export function upsertPapers(papers) {
  db.exec('BEGIN')
  try {
    for (const p of papers) {
      upsertPaperStmt.run(
        p.id, p.title, p.first_author || null, p.year || null, p.url || null,
        p.published || null, p.abstract || null, json(p.keywords || null),
        p.topic || null, p.community ?? null, p.community_label || null, p.degree ?? 0
      )
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function getPaper(id) {
  const r = db.prepare('SELECT * FROM papers WHERE id = ?').get(id)
  if (!r) return null
  return { ...r, keywords: unjson(r.keywords) }
}

export function allPapers() {
  return db.prepare('SELECT * FROM papers ORDER BY degree DESC').all().map(r => ({
    ...r, keywords: unjson(r.keywords)
  }))
}

// ---------- embeddings ----------

const setEmbeddingStmt = db.prepare(`
  INSERT INTO embeddings (paper_id, model, dim, vector) VALUES (?, ?, ?, ?)
  ON CONFLICT(paper_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vector = excluded.vector
`)

export function storeEmbedding(paperId, model, vector) {
  const buf = Buffer.allocUnsafe(vector.length * 4)
  for (let i = 0; i < vector.length; i++) buf.writeFloatLE(vector[i], i * 4)
  setEmbeddingStmt.run(paperId, model, vector.length, buf)
}

const toBuf = v => (v instanceof Uint8Array ? Buffer.from(v) : v)

export function loadEmbedding(paperId) {
  const r = db.prepare('SELECT model, dim, vector FROM embeddings WHERE paper_id = ?').get(paperId)
  if (!r) return null
  const buf = toBuf(r.vector)
  const out = new Float32Array(r.dim)
  for (let i = 0; i < r.dim; i++) out[i] = buf.readFloatLE(i * 4)
  return { model: r.model, vector: out }
}

export function allEmbeddings() {
  const rows = db.prepare('SELECT paper_id, dim, vector FROM embeddings').all()
  return rows.map(r => {
    const buf = toBuf(r.vector)
    const v = new Float32Array(r.dim)
    for (let i = 0; i < r.dim; i++) v[i] = buf.readFloatLE(i * 4)
    return { paperId: r.paper_id, vector: v }
  })
}

export function embeddingModel() {
  const r = db.prepare('SELECT model FROM embeddings LIMIT 1').get()
  return r?.model || null
}

export function clearEmbeddings() {
  db.exec('DELETE FROM embeddings')
}

// ---------- qa cache ----------
//
// The cache can be namespaced per agent (expert tasks vs the router/web app):
// the namespace is folded into the hash, so the same question asked to
// different agents gets separate entries while the stored question text stays
// clean for the popular-questions list. `null` namespace = the shared cache
// used by the router and the web chat.

const cacheGetStmt = db.prepare('SELECT * FROM qa_cache WHERE q_hash = ?')
const cachePutStmt = db.prepare(`
  INSERT INTO qa_cache (q_hash, question, answer, agent_id, hits, created_at)
  VALUES (?, ?, ?, ?, 1, ?)
  ON CONFLICT(q_hash) DO UPDATE SET hits = qa_cache.hits + 1
`)
const cacheHitStmt = db.prepare('UPDATE qa_cache SET hits = hits + 1 WHERE q_hash = ?')

function cacheKey(q, namespace) {
  return hashQuestion(namespace ? `${namespace}\u0000${q}` : q)
}

export function cacheGet(q, namespace) {
  const r = cacheGetStmt.get(cacheKey(q, namespace))
  return r || null
}

export function cachePut(q, answer, agentId, namespace) {
  cachePutStmt.run(cacheKey(q, namespace), q, answer, agentId || null, new Date().toISOString())
}

export function cacheRecordHit(q, namespace) {
  cacheHitStmt.run(cacheKey(q, namespace))
}

export function popularQuestions(limit = 12) {
  return db.prepare('SELECT question, answer, agent_id, hits, created_at FROM qa_cache ORDER BY hits DESC, created_at DESC LIMIT ?')
    .all(limit)
}

export function cacheSize() {
  return db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(hits), 0) AS hits FROM qa_cache').get()
}

export function clearCache() {
  db.exec('DELETE FROM qa_cache')
}

// ---------- agent messages (agent-to-agent communication log) ----------

const addMessageStmt = db.prepare(`
  INSERT INTO agent_messages (from_agent, to_agent, question, body, created_at)
  VALUES (?, ?, ?, ?, ?)
`)

export function addMessage(fromAgent, toAgent, question, body) {
  addMessageStmt.run(fromAgent, toAgent, question || null, body || null, new Date().toISOString())
}

export function getMessages(limit = 100) {
  return db.prepare('SELECT * FROM agent_messages ORDER BY id DESC LIMIT ?').all(limit).reverse()
}

export function messageCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get().n
}

// ---------- meta ----------

export function setMeta(k, v) {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v))
}

export function getMeta(k) {
  const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k)
  return r ? JSON.parse(r.v) : null
}

export function dbStats() {
  return {
    papers: db.prepare('SELECT COUNT(*) AS n FROM papers').get().n,
    embeddings: db.prepare('SELECT COUNT(*) AS n FROM embeddings').get().n,
    cache: cacheSize(),
    messages: messageCount(),
    embeddingModel: embeddingModel(),
  }
}

export default db
