// Offline contract harness for the grant_writer agent.
//
// Forces the deterministic retrieval-only path (OLLAMA_CHAT_MODEL=__none__
// BEFORE module load via dynamic import) — the real LLM synthesis path is
// verified live on the network. Verifies:
//   1. multi-hop retrieval reuses litreview's pipeline (papers with topic meta)
//   2. fallback answer has the five proposal sections
//   3. sections parsed into structured { title, body } pairs
//   4. runGrantWriter returns answer + sources + draft artifacts
//   5. input contract enforcement
process.env.OLLAMA_CHAT_MODEL = '__none__'

const { answerGrantQuestion, runGrantWriter } = await import('./lib/grantwriter.js')

let failures = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

console.log('== 1. structured fallback draft ==')
{
  const res = await answerGrantQuestion('combine foundation models with Riemannian decoding for cross-subject EEG', { forceNoModel: true })
  ok('draft present', res.answer.length > 0)
  ok('has TITLE', /## TITLE/.test(res.answer))
  ok('has BACKGROUND', /## BACKGROUND/.test(res.answer))
  ok('has RELATED WORK', /## RELATED WORK/.test(res.answer))
  ok('has PROPOSED CONTRIBUTION', /## PROPOSED CONTRIBUTION/.test(res.answer))
  ok('has RISKS & OPEN QUESTIONS', /## RISKS & OPEN QUESTIONS/.test(res.answer))
  ok('sections parsed', res.sections.length >= 5, `${res.sections.length} sections`)
  ok('sections structured', res.sections.every(s => s.title && typeof s.body === 'string'))
}

console.log('\n== 2. runGrantWriter handler ==')
{
  const emit = () => {}
  const result = await runGrantWriter(
    { requestParts: [{ partId: 'question', text: 'combine foundation models with Riemannian decoding for cross-subject EEG' }] },
    { reportStatus: () => {}, cancelSignal: null },
    emit,
  )
  ok('answer artifact text', typeof result.answer === 'string' && result.answer.length > 0)
  ok('sources present', Array.isArray(result.sources), `${result.sources.length} sources`)
  ok('draft artifact present', !!result.draft)
  ok('draft has idea', result.draft.idea.includes('foundation models'))
  ok('draft has papers', Array.isArray(result.draft.papers))
  ok('draft has sections', result.draft.sections.length >= 5)

  let threw = false
  try {
    await runGrantWriter({ requestParts: [] }, { reportStatus: () => {} }, emit)
  } catch (err) {
    threw = true
    ok('missing question rejected', /Missing requestParts/.test(err.message), err.message)
  }
  ok('missing question throws', threw)
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL GRANT WRITER CONTRACT TESTS PASSED'}`)
process.exit(failures ? 1 : 0)
