// Minimal Ollama REST client. No npm dependencies — uses global fetch.
export const OLLAMA_BASE = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '')
export const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || 'llama3.2:3b'
export const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text'

async function ollamaFetch(path, opts = {}) {
  const res = await fetch(`${OLLAMA_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) {
    throw new Error(`Ollama ${path} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim())
  }
  return res
}

export async function listModels() {
  try {
    const res = await ollamaFetch('/api/tags', { method: 'GET' })
    const j = await res.json()
    return (j.models || []).map(m => m.name)
  } catch {
    return []
  }
}

export async function hasModel(name) {
  const models = await listModels()
  return models.some(m => m === name || m.startsWith(name.split(':')[0] + ':'))
}

// ---------- embeddings ----------

export async function embed(text) {
  const input = String(text).slice(0, 8000)
  if (!input.trim()) return null
  // Modern API first, legacy as fallback
  try {
    const res = await ollamaFetch('/api/embed', {
      method: 'POST',
      body: JSON.stringify({ model: EMBED_MODEL, input }),
    })
    const j = await res.json()
    if (j.embeddings?.[0]) return j.embeddings[0]
    if (j.embedding) return j.embedding
    return null
  } catch {
    try {
      const res = await ollamaFetch('/api/embeddings', {
        method: 'POST',
        body: JSON.stringify({ model: EMBED_MODEL, prompt: input }),
      })
      const j = await res.json()
      return j.embedding || null
    } catch {
      return null
    }
  }
}

// ---------- chat ----------

// Stream a chat completion. Calls onToken(token) per token.
// Resolves to the full assistant text. Throws on error or missing model.
export async function chatStream({ model = CHAT_MODEL, messages, onToken, signal }) {
  const res = await ollamaFetch('/api/chat', {
    method: 'POST',
    signal,
    body: JSON.stringify({ model, messages, stream: true }),
  })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let errorText = null

  const handleLine = line => {
    if (!line.trim()) return
    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      return
    }
    if (payload.error) {
      errorText = payload.error
      return
    }
    const token = payload.message?.content ?? ''
    if (token) {
      full += token
      onToken?.(token)
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/^data:\s*/, '').trim()
        buffer = buffer.slice(idx + 1)
        if (line) handleLine(line)
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (errorText) throw new Error(`Ollama chat error: ${errorText}`)
  return full
}

export async function chat({ model = CHAT_MODEL, messages }) {
  const res = await ollamaFetch('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ model, messages, stream: false }),
  })
  const j = await res.json()
  if (j.error) throw new Error(`Ollama chat error: ${j.error}`)
  return j.message?.content ?? ''
}

export function systemMessage(content) {
  return { role: 'system', content }
}

export function userMessage(content) {
  return { role: 'user', content }
}
