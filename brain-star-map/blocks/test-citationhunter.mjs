// Offline contract harness for the citation_hunter agent (blocks/lib/citationhunter.js).
//
// No network, no SDK, no LLM — exercises the handler logic directly over the
// star-map graph and verifies:
//   1. "most cited" returns a ranked list with the honesty proxy note
//   2. "who cites <paper>" returns related papers (proxy neighbors)
//   3. "how many connections does <paper> have" returns a count
//   4. unknown paper / question guides gracefully
//   5. input contract (missing question rejected)
import { answerCitationQuestion, runCitationHunter } from './lib/citationhunter.js'
import { loadGraph } from './lib/graphexplorer.js'

let failures = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

console.log('== 0. graph available ==')
{
  const g = loadGraph()
  ok('graph_data.json loads', !!g, g ? `${g.nodes?.length} nodes / ${g.links?.length} links` : 'missing')
}

console.log('\n== 1. most cited ==')
{
  const res = answerCitationQuestion('most cited papers in Connectomics')
  ok('answer present', res.answer.length > 0)
  ok('proxy honesty note present', /keyword-co-occurrence proxy|proxy/i.test(res.answer))
  ok('ranked list present', /1\. /.test(res.answer), res.answer.slice(0, 100).replace(/\n/g, ' | '))
  ok('sources present', res.sources.length > 0, `${res.sources.length} sources`)
  ok('sources have arxiv urls', res.sources.every(s => /arxiv/.test(s.url)))
}

console.log('\n== 2. who cites a paper ==')
{
  // Pick the highest-degree paper so a title lookup is unambiguous.
  const g = loadGraph()
  const top = [...g.nodes].sort((a, b) => b.degree - a.degree)[0]
  const res = answerCitationQuestion(`who cites ${top.title.slice(0, 40)}`)
  ok('answer present', res.answer.length > 0)
  ok('relates to the top paper', new RegExp(top.title.slice(0, 25).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(res.answer), res.answer.slice(0, 120).replace(/\n/g, ' | '))
  ok('sources present', res.sources.length > 0, `${res.sources.length} neighbors`)
}

console.log('\n== 3. connection count ==')
{
  const g = loadGraph()
  const top = [...g.nodes].sort((a, b) => b.degree - a.degree)[0]
  const res = answerCitationQuestion(`how many connections does ${top.title.slice(0, 40)} have`)
  ok('answer present', res.answer.length > 0)
  ok('count is numeric', /\d+ direct connection/.test(res.answer), res.answer.slice(0, 120).replace(/\n/g, ' | '))
}

console.log('\n== 4. unknown paper ==')
{
  const res = answerCitationQuestion('who cites a totally made up paper zxqj qwertyuiop')
  ok('graceful guidance', /Could not find|most cited/i.test(res.answer), res.answer.slice(0, 120).replace(/\n/g, ' | '))
}

console.log('\n== 5. runCitationHunter handler ==')
{
  const ctx = { reportStatus: () => {} }
  const result = await runCitationHunter(
    { requestParts: [{ partId: 'question', text: 'most cited papers in the corpus' }] },
    ctx,
  )
  const artifacts = result.artifacts || []
  ok('answer artifact present', artifacts.some(a => a.outputId === 'answer' && typeof a.data === 'string'))

  let threw = false
  try {
    await runCitationHunter({ requestParts: [] }, ctx)
  } catch (err) {
    threw = true
    ok('missing question rejected', /Missing requestParts/.test(err.message), err.message)
  }
  ok('missing question throws', threw)
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL CITATION HUNTER CONTRACT TESTS PASSED'}`)
process.exit(failures ? 1 : 0)
