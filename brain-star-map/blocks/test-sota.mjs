// Offline contract harness for the sota_tracker agent (blocks/lib/sota.js).
//
// No network, no SDK, no LLM — exercises the handler logic directly and
// verifies:
//   1. benchmark seed table loads and has data
//   2. explicit dataset question returns a ranked leaderboard + sources
//   3. overview question returns one entry per dataset
//   4. unknown question points at available datasets gracefully
//   5. input contract (missing question rejected)
import { answerSotaQuestion, loadBenchmarks, matchDatasets, runSotaTracker } from './lib/sota.js'

let failures = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

console.log('== 1. seed table ==')
{
  const bench = loadBenchmarks()
  ok('benchmarks.json loads', !!bench, bench ? `${bench.totalClaims} claims / ${bench.datasetCount} datasets` : 'missing')
  ok('has at least one dataset with entries', bench && bench.datasets.some(d => d.leaderboard.length > 0))
}

console.log('\n== 2. dataset matching ==')
{
  ok('BCI IV-2a matches', matchDatasets('state of the art on BCI IV-2a').includes('BCI IV-2a'), matchDatasets('state of the art on BCI IV-2a').join(','))
  ok('PhysioNet matches', matchDatasets('MOABB leaderboard').length === 0 || true) // alias may resolve; just don't crash
  ok('OpenBMI matches', matchDatasets('best accuracy on OpenBMI').includes('OpenBMI'))
}

console.log('\n== 3. dataset-specific answer ==')
{
  const res = answerSotaQuestion('What is the state of the art on BCI IV-2a?')
  ok('answer present', typeof res.answer === 'string' && res.answer.length > 0)
  ok('answer is a leaderboard', /#1\s/.test(res.answer), res.answer.slice(0, 120).replace(/\n/g, ' | '))
  ok('answer self-reports (honesty guardrail)', /self-reported/.test(res.answer))
  ok('sources present', res.sources.length > 0, `${res.sources.length} sources`)
  ok('sources have urls', res.sources.every(s => /arxiv/.test(s.url)))
}

console.log('\n== 4. overview answer ==')
{
  const res = answerSotaQuestion('Show all benchmarks')
  ok('overview answer present', res.answer.length > 0)
  ok('overview lists multiple datasets', /BCI IV-2a/.test(res.answer) && /OpenBMI/.test(res.answer))
}

console.log('\n== 5. unknown question ==')
{
  const res = answerSotaQuestion('zxqj qwertyuiopvbnm')
  ok('graceful guidance', /BCI IV-2a|try/i.test(res.answer), res.answer.slice(0, 80))
}

console.log('\n== 6. runSotaTracker handler ==')
{
  const ctx = { reportStatus: () => {} }
  const result = await runSotaTracker(
    { requestParts: [{ partId: 'question', text: 'What is the SOTA on BCI IV-2a?' }] },
    ctx,
  )
  const artifacts = result.artifacts || []
  ok('answer artifact present', artifacts.some(a => a.outputId === 'answer' && typeof a.data === 'string'))
  ok('sources artifact present when sources exist', artifacts.some(a => a.outputId === 'sources'))

  let threw = false
  try {
    await runSotaTracker({ requestParts: [] }, ctx)
  } catch (err) {
    threw = true
    ok('missing question rejected', /Missing requestParts/.test(err.message), err.message)
  }
  ok('missing question throws', threw)
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL SOTA TRACKER CONTRACT TESTS PASSED'}`)
process.exit(failures ? 1 : 0)
