// paper_updates — live arXiv "what's new" stream (pipe agent).
//
// Evolves paper_feed: instead of re-streaming the static 215-paper corpus, this
// pipe queries the LIVE arXiv API for the newest papers on a topic (sorted by
// submission date, newest first) and streams them as structured events for the
// session duration — new submissions are picked up as the feed wraps around.
//
//   - taskKind: 'pipe' with a caller-set duration (1 min – 30 days)
//   - dedicated outbound events stream ("feed" — affinity: dedicated, same key
//     as paper_feed so the web console treats them identically)
//   - event shape: { type: 'paper', id, title, authors, published, url,
//     category, summary, source: 'arxiv', at }
//   - loop guarded by ctx.cancelSignal / ctx.isExpired
//   - summary artifact when the session ends
//
// Input: "topic" (required). Matcher/fetcher injectable for offline tests.

import { extractTopic } from './pipe.js'
import { arxivQuery, buildTopicQuery, snippet } from './arxiv.js'

// Sleep that aborts with the task's cancel signal (fires on caller cancel OR
// when the pipe duration expires). Same helper as paper_feed.
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }, { once: true })
  })
}

/**
 * Pipe handler for paper_updates.
 *
 * Streams newest-first pages from the arXiv API: page by page (newest -> older),
 * and when the end of the result set is reached, wraps back to page 0 so brand
 * new submissions are picked up until the caller stops or the duration expires.
 *
 * @param {object}  opts.intervalMs     delay between papers
 * @param {number}  opts.maxStreamed    cap for tests
 * @param {number}  opts.pageSize       arXiv page size (max 100)
 * @param {Function} opts.fetcher       (query, start, maxResults) => entries
 */
export async function runPaperUpdates(task, ctx, { intervalMs = 2500, maxStreamed = Infinity, pageSize = 10, fetcher = arxivQuery } = {}) {
  if (task?.taskKind !== 'pipe') {
    throw new Error('paper_updates only supports pipe tasks — send with taskKind: "pipe" and a duration')
  }
  if (!ctx?.createStream) {
    throw new Error('TaskContext with createStream is required for pipe streaming')
  }
  const topic = extractTopic(task)
  const query = buildTopicQuery(topic)

  const stream = await ctx.createStream({
    format: 'events',
    direction: 'outbound',
    declaredStream: 'feed',
    bundleSizeBytes: 2048,
    maxLatencyMs: 100,
  })

  ctx.reportStatus(`paper_updates: checking arXiv for new papers on "${topic}"…`)

  const seen = new Set()
  const streamedPapers = []
  let streamed = 0
  let start = 0
  let started = Date.now()
  let ended = 'ended'

  try {
    while (!ctx.cancelSignal.aborted && streamed < maxStreamed) {
      // Fetch one page of the newest papers (newest first).
      let batch
      try {
        batch = await fetcher({ query, maxResults: pageSize, start })
      } catch (err) {
        // A transient arXiv failure shouldn't kill the session — back off and
        // try again on the next loop.
        ctx.reportStatus(`paper_updates: arXiv fetch failed (${err.message}) — retrying…`)
        await sleep(5000, ctx.cancelSignal)
        continue
      }

      if (!batch.length) {
        // End of the result set — wrap to page 0 to catch new submissions.
        start = 0
        await sleep(intervalMs, ctx.cancelSignal)
        continue
      }

      let newInPage = 0
      for (const p of batch) {
        if (ctx.cancelSignal.aborted || streamed >= maxStreamed) break
        if (seen.has(p.arxivId)) continue
        seen.add(p.arxivId)
        stream.write({
          type: 'paper',
          id: p.arxivId,
          title: p.title,
          authors: p.authors,
          published: p.published,
          url: p.url,
          category: p.category,
          summary: snippet(p.summary),
          source: 'arxiv',
          at: new Date().toISOString(),
        })
        streamed++
        streamedPapers.push(p)
        newInPage++
        await sleep(intervalMs, ctx.cancelSignal)
      }

      // Advance the page; wrap to 0 once the result set is exhausted so fresh
      // submissions are discovered.
      start += pageSize
      if (batch.length < pageSize || newInPage === 0) start = 0
    }
  } catch (err) {
    if (err?.name !== 'AbortError') throw err
  }

  await stream.end()

  const durationSec = Math.round((Date.now() - started) / 1000)
  const publishedDates = streamedPapers.map(p => p.published).filter(Boolean).sort()
  return {
    artifacts: [{
      data: JSON.stringify({
        type: 'session_ended',
        topic,
        query,
        streamed,
        distinct: seen.size,
        source: 'arxiv',
        firstPublished: publishedDates[0] || null,
        lastPublished: publishedDates[publishedDates.length - 1] || null,
        durationSec,
        ended: ctx.isCancelled ? 'canceled' : ctx.isExpired ? 'expired' : 'ended',
      }, null, 2),
      mimeType: 'application/json',
      outputId: 'summary',
      fileName: 'summary.json',
    }],
  }
}
