import React, { useState, useRef, useEffect, useCallback } from 'react'

const API_BASE = ''

function readNDJSON(res, handlers) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pump = async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) {
          try { handlers.onEvent(JSON.parse(line)) } catch {}
        }
      }
    }
  }
  return pump()
}

export default function ChatPanel() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [popular, setPopular] = useState([])
  const [health, setHealth] = useState(null)
  const [activity, setActivity] = useState(null) // agent communication log
  const scrollRef = useRef(null)
  const msgIdRef = useRef(0)

  const scrollDown = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [])

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/health`)
      if (!r.ok) throw new Error('bad status')
      setHealth(await r.json())
    } catch {
      setHealth({ unreachable: true })
    }
  }, [])

  const loadPopular = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/popular`)
      const j = await r.json()
      setPopular(j.questions || [])
    } catch {}
  }, [])

  useEffect(() => {
    if (open) {
      loadHealth()
      loadPopular()
    }
  }, [open, loadHealth, loadPopular])

  useEffect(scrollDown, [messages, status])

  const send = useCallback(async (textOverride) => {
    const question = (textOverride ?? input).trim()
    if (!question || busy) return
    setInput('')
    setBusy(true)
    setStatus('Contacting agent network…')
    setMessages(m => [...m, { id: ++msgIdRef.current, role: 'user', text: question }])
    setMessages(m => [...m, { id: ++msgIdRef.current, role: 'assistant', text: '', streaming: true }])

    try {
      const res = await fetch(`${API_BASE}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, stream: true }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${res.status}`)
      }
      await readNDJSON(res, {
        onEvent(ev) {
          if (ev.type === 'status') setStatus(ev.message)
          if (ev.type === 'consult') setStatus(`${ev.from} → ${ev.to}: "${ev.question}"`)
          if (ev.type === 'token') {
            setMessages(m => {
              const last = m[m.length - 1]
              if (!last || !last.streaming) return m
              const next = [...m]
              next[next.length - 1] = { ...last, text: last.text + ev.text }
              return next
            })
          }
          if (ev.type === 'agent_start') {
            setMessages(m => {
              const last = m[m.length - 1]
              if (!last) return m
              const next = [...m]
              next[next.length - 1] = { ...last, agent: ev.name || ev.agent, agentId: ev.agent }
              return next
            })
          }
          if (ev.type === 'final') {
            setMessages(m => {
              const next = [...m]
              const last = next[next.length - 1]
              next[next.length - 1] = {
                ...last,
                text: ev.answer,
                streaming: false,
                cached: ev.cached,
                hits: ev.hits,
                agent: ev.agent,
                modelCalls: ev.modelCalls,
                sources: ev.sources || [],
              }
              return next
            })
            setStatus('')
            setBusy(false)
          }
          if (ev.type === 'error') {
            setMessages(m => {
              const next = [...m]
              const last = next[next.length - 1]
              next[next.length - 1] = { ...last, streaming: false, text: `⚠️ ${ev.message}` }
              return next
            })
            setStatus('')
            setBusy(false)
          }
        },
      })
    } catch (err) {
      setMessages(m => {
        const next = [...m]
        const last = next[next.length - 1]
        next[next.length - 1] = { ...last, streaming: false, text: `⚠️ ${err.message}` }
        return next
      })
      setStatus('')
      setBusy(false)
    }
  }, [input, busy])

  const toggleActivity = useCallback(async () => {
    if (activity) { setActivity(null); return }
    try {
      const r = await fetch(`${API_BASE}/api/messages?limit=40`)
      const j = await r.json()
      setActivity(j.messages || [])
    } catch {}
  }, [activity])

  if (!open) {
    return (
      <button className="chat-fab" onClick={() => setOpen(true)} title="Ask the expert agents">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
        Ask
      </button>
    )
  }

  const agentBadge = (m) => {
    if (!m.agent) return null
    const label = String(m.agent).startsWith('expert:')
      ? String(m.agent).replace('expert:', '').replace(/_/g, ' ')
      : m.agent
    return <span className="chat-badge">{label}{m.cached ? ' · cached' : ''}</span>
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-title">
          <span className="chat-title-dot" />
          Expert Agents
        </div>
        <div className="chat-header-actions">
          <button className="chat-mini-btn" onClick={toggleActivity} title="Agent communication log">
            {activity ? '✕ log' : 'agent log'}
          </button>
          <button className="chat-mini-btn" onClick={() => setOpen(false)} title="Close">✕</button>
        </div>
      </div>

      {health?.unreachable && (
        <div className="chat-notice">
          Agent server not reachable. Start it with <code>npm run serve</code> (after <code>npm run build-agent-db</code>).
        </div>
      )}
      {health && !health.unreachable && health.ollama && !health.ollama.chatReady && (
        <div className="chat-notice">
          LLM not ready — run <code>ollama pull {health.ollama.chatModel}</code>. Search &amp; cached answers still work.
        </div>
      )}

      <div className="chat-msgs" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Ask the expert agents about the <strong>{health?.db?.papers || 215}</strong> papers in this corpus.</p>
            <p className="chat-empty-sub">Popular questions answer instantly from cache — no model calls.</p>
            {popular.length > 0 && (
              <div className="chat-chips">
                {popular.slice(0, 6).map(p => (
                  <button key={p.q_hash} className="chat-chip" onClick={() => send(p.question)}>
                    {p.question}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            <div className="chat-msg-head">
              {m.role === 'assistant' ? agentBadge(m) : <span className="chat-badge user">You</span>}
              {m.role === 'assistant' && m.modelCalls !== undefined && !m.cached && (
                <span className="chat-meta">{m.modelCalls} model call{m.modelCalls === 1 ? '' : 's'}</span>
              )}
              {m.role === 'assistant' && m.cached && m.hits !== undefined && (
                <span className="chat-meta">hit #{m.hits}</span>
              )}
            </div>
            <div className="chat-bubble">
              {m.text || (m.streaming ? <span className="chat-typing" /> : '')}
              {m.streaming && m.text && <span className="chat-cursor" />}
            </div>
            {m.sources && m.sources.length > 0 && (
              <div className="chat-sources">
                {m.sources.map((s, i) => (
                  <a key={i} href={s.url} target="_blank" rel="noreferrer">{s.title.slice(0, 60)}{s.title.length > 60 ? '…' : ''}</a>
                ))}
              </div>
            )}
          </div>
        ))}
        {status && <div className="chat-status">⚙ {status}</div>}
      </div>

      {activity && (
        <div className="chat-activity">
          <div className="chat-activity-title">Agent communication log</div>
          {activity.length === 0 && <div className="chat-activity-empty">No messages yet.</div>}
          {activity.map(a => (
            <div key={a.id} className="chat-activity-row">
              <span className="chat-activity-agents">{a.from_agent} → {a.to_agent}</span>
              <span className="chat-activity-q">{(a.question || '').slice(0, 70)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="chat-input-row">
        <input
          className="chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send() }}
          placeholder="Ask about BCI, EEG decoding, connectomics…"
          disabled={busy}
        />
        <button className="chat-send" onClick={() => send()} disabled={busy || !input.trim()}>
          {busy ? '…' : '➤'}
        </button>
      </div>
    </div>
  )
}
