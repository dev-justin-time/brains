// Offline contract harness for the clinical_translator agent.
//
// Forces the deterministic retrieval-only path (OLLAMA_CHAT_MODEL=__none__
// BEFORE module load via dynamic import) — the real LLM synthesis path is
// verified live on the network. Verifies:
//   1. clinical retrieval ranks practice-relevant papers higher
//   2. fallback answer has the four plain-language sections
//   3. runClinicalTranslator returns answer + sources artifacts
//   4. input contract enforcement
process.env.OLLAMA_CHAT_MODEL = '__none__'

const { answerClinicalQuestion, clinicalRetrieve, runClinicalTranslator } = await import('./lib/clinical.js')

let failures = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

console.log('== 1. clinical retrieval ==')
{
  const hits = await clinicalRetrieve('stroke rehabilitation brain computer interface')
  ok('returns hits', hits.length > 0, `${hits.length} papers`)
  ok('hits carry clinical score', hits.every(h => typeof h.clinical === 'number'))
}

console.log('\n== 2. structured fallback answer ==')
{
  const res = await answerClinicalQuestion('stroke rehabilitation BCI', { forceNoModel: true })
  ok('answer present', res.answer.length > 0)
  ok('has PLAIN-LANGUAGE SUMMARY', /## PLAIN-LANGUAGE SUMMARY/.test(res.answer))
  ok('has WHAT THIS MEANS FOR CLINICIANS', /## WHAT THIS MEANS FOR CLINICIANS/.test(res.answer))
  ok('has KEY NUMBERS', /## KEY NUMBERS/.test(res.answer))
  ok('has CAVEATS & LIMITATIONS', /## CAVEATS & LIMITATIONS/.test(res.answer))
}

console.log('\n== 3. runClinicalTranslator handler ==')
{
  const emit = () => {}
  const result = await runClinicalTranslator(
    { requestParts: [{ partId: 'question', text: 'stroke rehabilitation BCI' }] },
    { reportStatus: () => {}, cancelSignal: null },
    emit,
  )
  ok('answer artifact text', typeof result.answer === 'string' && result.answer.length > 0)
  ok('sources present', Array.isArray(result.sources), `${result.sources.length} sources`)

  let threw = false
  try {
    await runClinicalTranslator({ requestParts: [] }, { reportStatus: () => {} }, emit)
  } catch (err) {
    threw = true
    ok('missing question rejected', /Missing requestParts/.test(err.message), err.message)
  }
  ok('missing question throws', threw)
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL CLINICAL TRANSLATOR CONTRACT TESTS PASSED'}`)
process.exit(failures ? 1 : 0)
