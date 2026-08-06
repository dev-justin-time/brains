// Pipe-streaming pipeline for the "paper_feed" agent.
//
// Follows the Blocks "Stream data" guide for pipe tasks:
//   - taskKind: 'pipe' with a caller-set duration (1 min – 30 days)
//   - dedicated outbound events stream ("feed" — affinity: dedicated)
//   - structured event objects per paper (type: 'paper', title, year, url, …)
//   - loop guarded by ctx.cancelSignal / ctx.isExpired
//   - summary artifact returned when the session ends
//
// Input contract (io.inputs[0].id): "topic" — a keyword or phrase to match
// against the corpus. Papers are matched with the same hybrid retrieval used
// by the web app (server/search.js), so the feed and the Q&A agents agree.

import { search } from '../../server/search.js'
import { allPapers } from '../../server/db.js'

// Sleep that aborts with the task's cancel signal (fires on caller cancel OR
// when the pipe duration expires). Mirrors the guide's stock-sim example.
// Checks the signal state FIRST — an 'abort' listener added to an
// already-aborted signal would never fire, and the session would spin forever.
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      return
    }
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }, { once: true })
  })
}

export function extractTopic(task) {
  const parts = task?.requestParts || []
  const byId = parts.filter(p => p.partId === 'topic')
  const noId = parts.filter(p => !p.partId)
  const mismatched = parts.find(p => p.partId && p.partId !== 'topic')
  if (mismatched && !byId.length) {
    throw new Error(`requestParts partId "${mismatched.partId}" does not match the declared input "topic"`)
  }
  const part = byId[0] || noId[0]
  const text = (part?.text ?? '').trim()
  if (!text) {
    throw new Error('Missing required input "topic" — send requestParts: [{ partId: "topic", text: "..." }]')
  }
  return text
}

// Match papers for the feed: hybrid retrieval on the topic, with a fallback
// pool of the highest-degree papers when nothing scores.
export function matchPapers(topic, { poolSize = 40 } = {}) {
  const hits = search(topic, { topK: poolSize })
  if (hits.length) return hits
  return allPapers().slice(0, poolSize).map(h => ({
    id: h.id, title: h.title, year: h.year, url: h.url,
    first_author: h.first_author, topic: h.community_label || h.topic,
    keywords: h.keywords || [],
  }))
}

/**
 * Pipe handler for paper_feed.
 *
 * Opens the dedicated "feed" events stream, streams matching papers one per
 * interval (cycling through the pool) until the caller cancels or the duration
 * expires, then returns a structured summary artifact.
 */
export async function runPaperFeed(task, ctx, { intervalMs = 1500, maxStreamed = Infinity, matcher = matchPapers } = {}) {
  if (task?.taskKind !== 'pipe') {
    throw new Error('paper_feed only supports pipe tasks — send with taskKind: "pipe" and a duration')
  }
  if (!ctx?.createStream) {
    throw new Error('TaskContext with createStream is required for pipe streaming')
  }
  const topic = extractTopic(task)

  // Dedicated outbound events stream — must match the card's streams.feed key.
  const stream = await ctx.createStream({
    format: 'events',
    direction: 'outbound',
    declaredStream: 'feed',
    bundleSizeBytes: 2048,
    maxLatencyMs: 100,
  })

  const pool = matcher(topic)
  if (!pool.length) {
    // Nothing to stream — end immediately with a zero-count summary instead
    // of spinning until the duration expires.
    ctx.reportStatus(`paper_feed: no papers matched "${topic}" — ending session.`)
    return {
      artifacts: [{
        data: JSON.stringify({
          type: 'session_ended',
          topic,
          streamed: 0,
          poolSize: 0,
          durationSec: 0,
          ended: 'no_matches',
        }, null, 2),
        mimeType: 'application/json',
        outputId: 'summary',
        fileName: 'summary.json',
      }],
    }
  }
  ctx.reportStatus(`paper_feed: streaming ${pool.length} paper(s) matching "${topic}"…`)

  let streamed = 0
  let started = Date.now()
  try {
    while (!ctx.cancelSignal.aborted && streamed < maxStreamed) {
      for (const p of pool) {
        if (ctx.cancelSignal.aborted || streamed >= maxStreamed) break
        stream.write({
          type: 'paper',
          id: p.id,
          title: p.title,
          year: p.year,
          url: p.url,
          first_author: p.first_author || null,
          topic: p.topic || null,
          keywords: p.keywords || [],
          at: new Date().toISOString(),
        })
        streamed++
        await sleep(intervalMs, ctx.cancelSignal)
      }
    }
  } catch (err) {
    // AbortError — canceled by caller or duration expired. Normal pipe end.
    if (err?.name !== 'AbortError') throw err
  }

  await stream.end()

  const durationSec = Math.round((Date.now() - started) / 1000)
  return {
    artifacts: [{
      data: JSON.stringify({
        type: 'session_ended',
        topic,
        streamed,
        poolSize: pool.length,
        durationSec,
        ended: ctx.isCancelled ? 'canceled' : ctx.isExpired ? 'expired' : 'ended',
      }, null, 2),
      mimeType: 'application/json',
      outputId: 'summary',
      fileName: 'summary.json',
    }],
  }
}
