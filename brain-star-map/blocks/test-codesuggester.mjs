// Offline contract harness for the code_suggester agent (blocks/lib/codesuggester.js).
//
// Forces the deterministic retrieval-only path (OLLAMA_CHAT_MODEL=__none__
// BEFORE module load via dynamic import) — the real LLM synthesis path is
// verified live on the network. Verifies:
//   1. structured fallback answer has the five sections
//   2. runCodeSuggester returns answer + sources + skeleton artifacts
//   3. input contract enforcement
process.env.OLLAMA_CHAT_MODEL = '__none__'

const { answerCodeQuestion, runCodeSuggester } = await import('./lib/codesuggester.js')

let failures = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

console.log('== 1. structured fallback answer ==')
{
  const res = await answerCodeQuestion('CNN-LSTM architecture for motor imagery decoding', { forceNoModel: true })
  ok('answer present', res.answer.length > 0)
  ok('has ARCHITECTURE OVERVIEW', /## ARCHITECTURE OVERVIEW/.test(res.answer))
  ok('has PYTORCH SKELETON', /## PYTORCH SKELETON/.test(res.answer))
  ok('has DATA & PREPROCESSING', /## DATA & PREPROCESSING/.test(res.answer))
  ok('has TRAINING & EVALUATION', /## TRAINING & EVALUATION/.test(res.answer))
  ok('has LIMITATIONS', /## LIMITATIONS/.test(res.answer))
  ok('sections parsed', res.sections.length === 5, `${res.sections.length} sections`)
  ok('retrieval context present', res.context.length > 0, `${res.context.length} papers`)
}

console.log('\n== 2. runCodeSuggester handler ==')
{
  const emit = () => {}
  const result = await runCodeSuggester(
    { requestParts: [{ partId: 'question', text: 'Riemannian self-attention EEG decoder skeleton' }] },
    { reportStatus: () => {}, cancelSignal: null },
    emit,
  )
  ok('answer artifact text', typeof result.answer === 'string' && result.answer.length > 0)
  ok('sources present', Array.isArray(result.sources), `${result.sources.length} sources`)
  ok('skeleton artifact present', !!result.skeleton && Array.isArray(result.skeleton.sections), `skeleton.sections: ${result.skeleton?.sections?.length}`)

  let threw = false
  try {
    await runCodeSuggester({ requestParts: [] }, { reportStatus: () => {} }, emit)
  } catch (err) {
    threw = true
    ok('missing question rejected', /Missing requestParts/.test(err.message), err.message)
  }
  ok('missing question throws', threw)
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL CODE SUGGESTER CONTRACT TESTS PASSED'}`)
process.exit(failures ? 1 : 0)
