// HTTP server for the expert-agent system.
// Serves the built front-end (dist/) + the /api endpoints.
// Zero npm dependencies — native node:http.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ask, rosterInfo } from './agents.js'
import { search, indexStats, indexLoaded, embedQuestion } from './search.js'
import { popularQuestions, getMessages, clearCache, dbStats, cacheGet, normalizeQuestion } from './db.js'
import { listModels, hasModel, CHAT_MODEL, EMBED_MODEL, OLLAMA_BASE } from './ollama.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST_DIR = process.env.DIST_DIR || path.join(__dirname, '..', 'dist')
const PORT = parseInt(process.env.PORT || '3001', 10)

// ---------- tiny helpers ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
  res.end(body)
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message })
}

async function readBody(req, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Error('Body too large')
    chunks.push(c)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// ---------- static file serving ----------

function serveStatic(req, res, urlPath) {
  if (urlPath === '/') urlPath = '/index.html'
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '')
  const filePath = path.join(DIST_DIR, safe)
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback for client-side routes (none exist today, but future-proof)
      if (urlPath === '/index.html' || !path.extname(urlPath)) {
        fs.readFile(path.join(DIST_DIR, 'index.html'), (e2, html) => {
          if (e2) { res.writeHead(404); res.end('Not found'); return }
          res.writeHead(200, { 'Content-Type': MIME['.html'] })
          res.end(html)
        })
        return
      }
      res.writeHead(404); res.end('Not found'); return
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' })
    res.end(data)
  })
}

// ---------- NDJSON event stream ----------

function startStream(res) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  })
  return (event) => res.write(JSON.stringify(event) + '\n')
}

// ---------- API handlers ----------

async function handleAsk(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch {
    return sendError(res, 400, 'Invalid JSON body')
  }
  const question = String(body.question || '').trim()
  if (!question) return sendError(res, 400, 'Missing "question"')

  const stream = body.stream !== false
  if (!stream) {
    const result = await ask(question, { emit: () => {}, stream: false })
    return sendJson(res, 200, result)
  }

  const emit = startStream(res)
  try {
    await ask(question, { emit, stream: true })
  } catch (err) {
    emit({ type: 'error', message: err.message })
  }
  res.end()
}

async function handleSearch(req, res, url) {
  const q = new URL(url, 'http://x').searchParams.get('q') || ''
  if (!q) return sendError(res, 400, 'Missing "q"')
  // Embed the query so vector similarity is used when embeddings exist (best-effort)
  const qVec = await embedQuestion(q).catch(() => null)
  const results = qVec ? search(qVec, { topK: 8 }) : search(q, { topK: 8 })
  sendJson(res, 200, { query: q, count: results.length, vector: !!qVec, results })
}

async function handleHealth(res) {
  const models = await listModels()
  const chatReady = await hasModel(CHAT_MODEL)
  const embedReady = await hasModel(EMBED_MODEL)
  sendJson(res, 200, {
    ok: true,
    db: dbStats(),
    index: indexLoaded() ? indexStats() : { loaded: false },
    ollama: {
      base: OLLAMA_BASE,
      reachable: models.length > 0 || chatReady || embedReady,
      models,
      chatModel: CHAT_MODEL,
      chatReady,
      embedModel: EMBED_MODEL,
      embedReady,
    },
    agents: rosterInfo().length,
  })
}

async function handleAgents(res) {
  const roster = rosterInfo()
  sendJson(res, 200, {
    count: roster.length,
    agents: roster.map(a => ({
      ...a,
      paperCount: a.paperCount,
    })),
    db: dbStats(),
  })
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)

  // CORS preflight (for vite dev server on another port)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }

  try {
    if (urlPath === '/api/health' && req.method === 'GET') return await handleHealth(res)
    if (urlPath === '/api/agents' && req.method === 'GET') return await handleAgents(res)
    if (urlPath === '/api/ask' && req.method === 'POST') return await handleAsk(req, res)
    if (urlPath === '/api/search' && req.method === 'GET') return await handleSearch(req, res, req.url)
    if (urlPath === '/api/popular' && req.method === 'GET') return sendJson(res, 200, { questions: popularQuestions() })
    if (urlPath === '/api/messages' && req.method === 'GET') return sendJson(res, 200, { messages: getMessages() })
    if (urlPath === '/api/cache/clear' && req.method === 'POST') {
      clearCache()
      return sendJson(res, 200, { ok: true, db: dbStats() })
    }
    if (urlPath === '/api/lookup' && req.method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams.get('q') || ''
      const hit = cacheGet(q)
      return sendJson(res, 200, { hit })
    }
    if (urlPath.startsWith('/api/')) return sendError(res, 404, `Unknown API route: ${urlPath}`)

    // Static files
    return serveStatic(req, res, urlPath)
  } catch (err) {
    console.error('[server] error:', err)
    if (!res.headersSent) return sendError(res, 500, err.message)
    res.end()
  }
})

server.listen(PORT, () => {
  console.log(`\n  Expert-agent server: http://localhost:${PORT}`)
  console.log(`  Ollama: ${OLLAMA_BASE} | chat: ${CHAT_MODEL} | embed: ${EMBED_MODEL}`)
  console.log(`  API: /api/health /api/agents /api/ask /api/search /api/popular /api/messages`)
  console.log(`  DB: ${process.env.AGENT_DB_PATH || path.join(__dirname, '..', 'data', 'agents.db')}\n`)
})
