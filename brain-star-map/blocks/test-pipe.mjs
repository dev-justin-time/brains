// Offline contract harness for the paper_feed pipe pipeline (blocks/lib/pipe.js).
//
// Exercises runPaperFeed with a mocked TaskContext — no network, no SDK. The
// fake stream collects every written event; the cancel signal fires after N
// events so the test terminates quickly. Verifies:
//   1. pipe tasks only (request task rejected)
//   2. input contract (partId "topic" required; mismatch rejected)
//   3. events streamed have the expected paper shape (type, title, year, url)
//   4. summary artifact returned with correct counts
//   5. cancellation is honored (loop stops when cancelSignal fires)
import { runPaperFeed, extractTopic, matchPapers } from './lib/pipe.js'

let failures = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

// ---- fake stream -----------------------------------------------------------

function makeFakeStream() {
  const written = []
  let ended = false
  return {
    written,
    ended: () => ended,
    write: (data) => written.push(data),
    end: async () => { ended = true },
    onError: () => {},
    uuid: 'test-feed',
  }
}

// ---- fake ctx: cancel after `maxEvents` events ------------------------------

function makeCtx({ stream, intervalMs = 5, maxEvents = 3 }) {
  let count = 0
  const controller = new AbortController()
  // Fire the cancel signal after maxEvents writes (hook into stream.write).
  const origWrite = stream.write.bind(stream)
  stream.write = (data) => {
    origWrite(data)
    if (++count >= maxEvents) controller.abort()
  }
  const events = []
  return {
    stream,
    events,
    reportStatus: (m) => events.push({ type: 'status', message: m }),
    cancelSignal: controller.signal,
    isCancelled: false,
    isExpired: false,
    hasStream: true,
    createStream: async (opts) => {
      if (opts.declaredStream !== 'feed') throw new Error(`expected declaredStream "feed", got "${opts.declaredStream}"`)
      if (opts.format !== 'events') throw new Error(`expected format events, got ${opts.format}`)
      return stream
    },
  }
}

// ---- tests -----------------------------------------------------------------

console.log('== 1. task kind contract ==')
{
  const stream = makeFakeStream()
  const ctx = makeCtx({ stream })
  let threw = false
  try {
    await runPaperFeed({ taskKind: 'request', requestParts: [{ partId: 'topic', text: 'eeg' }] }, ctx)
  } catch (err) {
    threw = true
    ok('request task rejected', /only supports pipe tasks/.test(err.message), err.message)
  }
  ok('non-pipe task throws', threw)
}

console.log('\n== 2. input contract ==')
{
  const stream = makeFakeStream()
  const ctx = makeCtx({ stream })
  let threw = false
  try {
    await runPaperFeed({ taskKind: 'pipe', requestParts: [{ partId: 'question', text: 'eeg' }] }, ctx)
  } catch (err) {
    threw = true
    ok('mismatched partId rejected', /does not match the declared input "topic"/.test(err.message), err.message)
  }
  ok('mismatch throws', threw)

  let threw2 = false
  try {
    extractTopic({ requestParts: [] })
  } catch (err) {
    threw2 = true
    ok('missing topic rejected', /Missing required input "topic"/.test(err.message))
  }
  ok('missing throws', threw2)
}

console.log('\n== 3. streaming shape + cancellation ==')
{
  const stream = makeFakeStream()
  const ctx = makeCtx({ stream, intervalMs: 5, maxEvents: 3 })
  const result = await runPaperFeed({ taskKind: 'pipe', requestParts: [{ partId: 'topic', text: 'EEG motor imagery' }] }, ctx)

  const papers = stream.written
  ok('streamed at least 1 event', papers.length >= 1, `${papers.length} events`)
  ok('cancel signal honored (<= maxEvents + pool remainder)', papers.length <= 6, `${papers.length} written`)
  if (papers[0]) {
    const p = papers[0]
    ok('event has type=paper', p.type === 'paper', JSON.stringify(p).slice(0, 80))
    ok('event has title', typeof p.title === 'string' && p.title.length > 0)
    ok('event has year', typeof p.year === 'number' || p.year == null)
    ok('event has url', typeof p.url === 'string' || p.url == null)
    ok('event has at timestamp', typeof p.at === 'string')
  }
  ok('stream ended', stream.ended())

  const artifacts = result.artifacts || []
  ok('summary artifact returned', artifacts.length === 1 && artifacts[0].outputId === 'summary')
  if (artifacts[0]) {
    const summary = JSON.parse(artifacts[0].data)
    ok('summary.streamed matches', summary.streamed === papers.length, `streamed=${summary.streamed}`)
    ok('summary.topic matches', summary.topic === 'EEG motor imagery')
    ok('summary.poolSize > 0', summary.poolSize > 0, `pool=${summary.poolSize}`)
    ok('summary.ended reported', ['canceled', 'expired', 'ended'].includes(summary.ended), summary.ended)
  }
}

console.log('\n== 4. matchPapers reuse (hybrid retrieval) ==')
{
  const pool = matchPapers('graph neural networks', { poolSize: 5 })
  ok('matchPapers returns papers', Array.isArray(pool) && pool.length > 0, `${pool.length} hits`)
  ok('matchPapers has corpus fields', !!pool[0]?.title && !!pool[0]?.id)
}

console.log('\n== 5. empty pool ends immediately ==')
{
  // Force an empty pool via the injectable matcher and confirm runPaperFeed
  // returns a zero-streamed summary instead of spinning until expiry.
  const stream = makeFakeStream()
  const ctx = makeCtx({ stream, intervalMs: 5, maxEvents: 999 })
  const result = await runPaperFeed(
    { taskKind: 'pipe', requestParts: [{ partId: 'topic', text: 'anything' }] },
    ctx,
    { matcher: () => [] },
  )
  const artifacts = result.artifacts || []
  const summary = artifacts[0] ? JSON.parse(artifacts[0].data) : null
  ok('empty pool returns a summary', !!summary, summary ? JSON.stringify(summary).slice(0, 100) : 'no summary')
  ok('empty pool summary streamed=0', summary ? summary.streamed === 0 : false)
  ok('empty pool summary poolSize=0', summary ? summary.poolSize === 0 : false)
  ok('empty pool wrote no events', stream.written.length === 0, `${stream.written.length} events`)
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PIPE CONTRACT TESTS PASSED'}`)
process.exit(failures ? 1 : 0)
