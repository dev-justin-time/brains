// Offline contract harness for the lit_review agent (blocks/lib/litreview.js).
//
// No network, no SDK — exercises the retrieval + synthesis logic directly and
// verifies:
//   1. multi-hop retrieval merges global + per-topic hits and dedupes by url
//   2. answer has the four review sections (LLM or retrieval fallback)
//   3. sections are parsed into structured { title, body } pairs
//   4. runLitReview returns answer + sources + review artifacts
//   5. input contract (missing question rejected) + focus input
// Force the deterministic retrieval-only path for the offline harness:
// hasModel() resolves false -> no LLM call, so the test is fast and stable
// on any machine. The real LLM synthesis path is verified live on the
// network instead. Must be set BEFORE the module graph loads (CHAT_MODEL is
// read at import time), hence the dynamic import below.
process.env.OLLAMA_CHAT_MODEL = '__none__'

const { multiHopRetrieve, answerLitReview, runLitReview, collectSections } = await import('./lib/litreview.js')

let failures = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

console.log('== 1. multi-hop retrieval ==')
{
  const hits = await multiHopRetrieve('motor imagery EEG decoding')
  ok('returns hits', hits.length > 0, `${hits.length} papers`)
  const urls = hits.map(h => h.url)
  ok('no duplicate urls', new Set(urls).size === urls.length)
  ok('hits carry topic metadata', hits.every(h => h.topic && h.title && h.year))
}

console.log('\n== 2. structured answer (LLM or fallback) ==')
{
  const res = await answerLitReview('motor imagery EEG decoding', 'compare decoders', { forceNoModel: true })
  ok('answer present', typeof res.answer === 'string' && res.answer.length > 0)
  ok('has OVERVIEW section', /## OVERVIEW/.test(res.answer))
  ok('has METHOD COMPARISON section', /## METHOD COMPARISON/.test(res.answer))
  ok('has KEY FINDINGS section', /## KEY FINDINGS/.test(res.answer))
  ok('has GAPS section', /## GAPS/.test(res.answer))
  ok('sections parsed', res.sections.length >= 4, `${res.sections.length} sections`)
  ok('sections are structured', res.sections.every(s => s.title && typeof s.body === 'string'))
}

console.log('\n== 3. collectSections edge cases ==')
{
  const parsed = collectSections('## A\none\n## B\ntwo')
  ok('two sections parsed', parsed.length === 2, parsed.map(s => s.title).join(','))
  ok('bodies correct', parsed[0].body === 'one' && parsed[1].body === 'two')
  const none = collectSections('no headings here')
  ok('no headings -> empty', none.length === 0)
}

console.log('\n== 4. runLitReview handler ==')
{
  const emit = () => {}
  const result = await runLitReview(
    { requestParts: [{ partId: 'question', text: 'motor imagery EEG decoding' }, { partId: 'focus', text: 'compare decoders' }] },
    { reportStatus: () => {}, cancelSignal: null },
    emit,
  )
  ok('answer artifact text', typeof result.answer === 'string' && result.answer.length > 0)
  ok('sources present', Array.isArray(result.sources) && result.sources.length > 0, `${result.sources.length} sources`)
  ok('review artifact present', !!result.review)
  ok('review has question', result.review.question.includes('motor imagery'))
  ok('review has focus', result.review.focus === 'compare decoders')
  ok('review has papers', Array.isArray(result.review.papers) && result.review.papers.length > 0)
  ok('review has sections', result.review.sections.length >= 4)

  let threw = false
  try {
    await runLitReview({ requestParts: [] }, { reportStatus: () => {} }, emit)
  } catch (err) {
    threw = true
    ok('missing question rejected', /Missing requestParts/.test(err.message), err.message)
  }
  ok('missing question throws', threw)
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL LIT REVIEW CONTRACT TESTS PASSED'}`)
process.exit(failures ? 1 : 0)
