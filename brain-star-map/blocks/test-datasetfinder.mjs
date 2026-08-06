// Offline contract harness for the dataset_finder agent (blocks/lib/datasetfinder.js).
//
// No network, no SDK, no LLM — exercises the handler logic directly and verifies:
//   1. datasets seed table loads and has data
//   2. topic matching (motor imagery -> BCI IV-2a, seizure -> CHB-MIT)
//   3. explicit dataset name returns a full card + sources
//   4. overview question lists datasets
//   5. unknown question guides gracefully
//   6. input contract (missing question rejected)
import { answerDatasetQuestion, loadDatasets, matchDatasetsForQuestion, runDatasetFinder } from './lib/datasetfinder.js'

let failures = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

console.log('== 1. seed table ==')
{
  const dir = loadDatasets()
  ok('datasets.json loads', !!dir, dir ? `${dir.datasetCount} datasets` : 'missing')
  ok('has BCI IV-2a with task', !!dir && dir.datasets.some(d => d.id === 'BCI IV-2a' && d.task))
  ok('has benchmark SOTA somewhere', !!dir && dir.datasets.some(d => d.sota && d.sota.value != null))
}

console.log('\n== 2. topic matching ==')
{
  const mi = matchDatasetsForQuestion('Which dataset for motor imagery decoding?')
  ok('motor imagery -> BCI IV-2a', mi.some(r => r.dataset.id === 'BCI IV-2a'), mi.map(r => r.dataset.id).join(','))
  ok('motor imagery -> PhysioNet MI too', mi.some(r => r.dataset.id === 'PhysioNet MI'), mi.map(r => r.dataset.id).join(','))
  const sz = matchDatasetsForQuestion('dataset for seizure detection')
  ok('seizure -> CHB-MIT', sz.some(r => r.dataset.id === 'CHB-MIT'), sz.map(r => r.dataset.id).join(','))
  const named = matchDatasetsForQuestion('details on WAY-EEG-GAL')
  ok('explicit name marks named', named.some(r => r.named && r.dataset.id === 'WAY-EEG-GAL'))
}

console.log('\n== 3. explicit dataset answer ==')
{
  const res = answerDatasetQuestion('details on BCI IV-2a')
  ok('answer present', typeof res.answer === 'string' && res.answer.length > 0)
  ok('answer has dataset card', /BCI IV-2a/.test(res.answer), res.answer.slice(0, 90).replace(/\n/g, ' | '))
  ok('answer notes license honesty', /license/i.test(res.answer))
  ok('answer carries task', /Motor imagery/i.test(res.answer))
}

console.log('\n== 4. overview answer ==')
{
  const res = answerDatasetQuestion('list all datasets')
  ok('overview present', res.answer.length > 0)
  ok('overview lists many datasets', (res.answer.match(/- /g) || []).length >= 5)
  ok('overview honest note', /seed/i.test(res.answer))
}

console.log('\n== 5. unknown question ==')
{
  const res = answerDatasetQuestion('zxqj qwertyuiopvbnm')
  ok('graceful guidance', /Try|datasets on file/i.test(res.answer), res.answer.slice(0, 90))
}

console.log('\n== 6. runDatasetFinder handler ==')
{
  const ctx = { reportStatus: () => {} }
  const result = await runDatasetFinder(
    { requestParts: [{ partId: 'question', text: 'Which dataset for cross-subject motor imagery?' }] },
    ctx,
  )
  const artifacts = result.artifacts || []
  ok('answer artifact present', artifacts.some(a => a.outputId === 'answer' && typeof a.data === 'string'))
  ok('sources artifact present when sources exist', artifacts.some(a => a.outputId === 'sources'))

  let threw = false
  try {
    await runDatasetFinder({ requestParts: [] }, ctx)
  } catch (err) {
    threw = true
    ok('missing question rejected', /Missing requestParts/.test(err.message), err.message)
  }
  ok('missing question throws', threw)
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL DATASET FINDER CONTRACT TESTS PASSED'}`)
process.exit(failures ? 1 : 0)
