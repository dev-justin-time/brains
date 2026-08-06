// Offline contract harness for the paper_updates pipe agent (blocks/lib/paperupdates.js).
//
// No network — the arXiv fetcher is injected (a fake that pages through a fixed
// list), and the pipe loop is capped with maxStreamed. Verifies:
//   1. streams newest papers as 'paper' events and ends with a summary artifact
//   2. dedupes repeated arXiv ids within a page
//   3. input contract (missing topic rejected)
import { runPaperUpdates } from './lib/paperupdates.js'
import { buildTopicQuery, parseAtom } from './lib/arxiv.js'

let failures = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

const PAPERS = [
  { arxivId: '2608.00001', title: 'Newest Paper One', authors: ['A. One'], published: '2026-08-05', url: 'https://arxiv.org/abs/2608.00001', category: 'eess.SP', summary: 'Abstract one ' + 'x'.repeat(200) },
  { arxivId: '2608.00002', title: 'Newest Paper Two', authors: ['B. Two'], published: '2026-08-05', url: 'https://arxiv.org/abs/2608.00002', category: 'cs.LG', summary: 'Abstract two' },
  { arxivId: '2608.00003', title: 'Newest Paper Three', authors: ['C. Three'], published: '2026-08-04', url: 'https://arxiv.org/abs/2608.00003', category: 'q-bio.NC', summary: 'Abstract three' },
]

function fakeCtx() {
  const events = []
  const abort = new AbortController()
  const stream = {
    write: ev => events.push(ev),
    end: async () => {},
  }
  return {
    events,
    abort,
    createStream: async () => stream,
    reportStatus: () => {},
    cancelSignal: abort.signal,
    isCancelled: false,
    isExpired: false,
  }
}

console.log('== 1. streams + summary artifact ==')
{
  const ctx = fakeCtx()
  const result = await runPaperUpdates(
    { taskKind: 'pipe', requestParts: [{ partId: 'topic', text: 'motor imagery' }] },
    ctx,
    { intervalMs: 1, maxStreamed: 3, pageSize: 2, fetcher: async ({ maxResults, start }) => PAPERS.slice(start, start + maxResults) },
  )
  const papers = ctx.events.filter(e => e.type === 'paper')
  ok('streamed 3 paper events', papers.length === 3, `${papers.length} events`)
  ok('events carry arXiv fields', papers.every(p => p.source === 'arxiv' && p.id && p.title && p.url), JSON.stringify(papers[0]))
  ok('summary artifact present', result.artifacts?.some(a => a.outputId === 'summary'), 'no summary')
  const summary = JSON.parse(result.artifacts.find(a => a.outputId === 'summary').data)
  ok('summary counts streamed', summary.streamed === 3, `streamed=${summary.streamed}`)
  ok('summary tracks published range', !!summary.firstPublished && !!summary.lastPublished, `${summary.firstPublished} .. ${summary.lastPublished}`)
  ok('summary records source', summary.source === 'arxiv')
}

console.log('\n== 2. dedupe within a page ==')
{
  const ctx = fakeCtx()
  const dup = [PAPERS[0], PAPERS[0], PAPERS[1]]
  // The fetcher keeps returning the same page (as if arXiv had nothing new);
  // the session ends via the cancel signal (like a caller stopping the feed).
  const abortTimer = setTimeout(() => ctx.abort.abort(), 120)
  const result = await runPaperUpdates(
    { taskKind: 'pipe', requestParts: [{ partId: 'topic', text: 'eeg' }] },
    ctx,
    { intervalMs: 2, maxStreamed: 1000, pageSize: 5, fetcher: async () => dup },
  )
  clearTimeout(abortTimer)
  const papers = ctx.events.filter(e => e.type === 'paper')
  ok('duplicate id streamed once', papers.length === 2, `${papers.length} events`)
  ok('summary artifact still present after abort', result.artifacts?.some(a => a.outputId === 'summary'), 'no summary')
}

console.log('\n== 3. input contract ==')
{
  const ctx = fakeCtx()
  let threw = false
  try {
    await runPaperUpdates({ taskKind: 'pipe', requestParts: [] }, ctx, { intervalMs: 1, maxStreamed: 1, fetcher: async () => [] })
  } catch (err) {
    threw = true
    ok('missing topic rejected', /Missing required input "topic"/.test(err.message), err.message)
  }
  ok('missing topic throws', threw)
}

console.log('\n== 4. helpers ==')
{
  ok('buildTopicQuery quotes phrase', buildTopicQuery('motor imagery') === 'all:"motor imagery"', buildTopicQuery('motor imagery'))
  ok('buildTopicQuery ORs comma terms', buildTopicQuery('eeg, motor imagery') === 'all:"eeg" OR all:"motor imagery"', buildTopicQuery('eeg, motor imagery'))
  const xml = `<?xml version="1.0"?><feed><entry><id>http://arxiv.org/abs/2608.00001v1</id><title>  Test   Title  </title><summary> A   bstract </summary><published>2026-08-05</published><author><name>Jane Doe</name></author><arxiv:primary_category term="eess.SP"/></entry></feed>`
  const parsed = parseAtom(xml)
  ok('parseAtom extracts entry', parsed.length === 1, `${parsed.length} entries`)
  ok('parseAtom normalizes whitespace', parsed[0].title === 'Test Title', parsed[0]?.title)
  ok('parseAtom extracts arxivId', parsed[0].arxivId === '2608.00001v1', parsed[0]?.arxivId)
  ok('parseAtom extracts authors', parsed[0].authors[0] === 'Jane Doe')
  ok('parseAtom extracts category', parsed[0].category === 'eess.SP')
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PAPER UPDATES CONTRACT TESTS PASSED'}`)
process.exit(failures ? 1 : 0)
