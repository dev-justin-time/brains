// Offline contract harness for the graph_explorer agent (blocks/lib/graphexplorer.js).
//
// Pure graph computation — no network, no LLM, no SDK. Verifies:
//   1. graph loads from public/graph_data.json
//   2. centrality ranking (per topic + global)
//   3. subgraph around a paper (1-hop) + subgraph artifact
//   4. communities overview
//   5. bridge papers (betweenness)
//   6. shortest path between two papers
//   7. fallback + guidance for unrecognized questions
//   8. runGraphExplorer handler: answer + optional subgraph artifact
import { answerGraphQuestion, loadGraph, runGraphExplorer } from './lib/graphexplorer.js'

let failures = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

console.log('== 1. graph loads ==')
{
  const g = loadGraph()
  ok('graph_data.json loads', !!g, g ? `${g.nodes.length} nodes / ${g.links.length} links` : 'missing')
  ok('has nodes with titles', g && g.nodes.length > 100 && g.nodes.every(n => n.title))
}

console.log('\n== 2. centrality ranking ==')
{
  const res = answerGraphQuestion('Most central papers in Connectomics')
  ok('answer present', res.answer.length > 0)
  ok('topic-filtered', /Connectomics/.test(res.answer) && /1\. /.test(res.answer), res.answer.slice(0, 90))
  const global = answerGraphQuestion('top papers in the corpus by centrality')
  ok('global ranking works', /1\. /.test(global.answer))
}

console.log('\n== 3. subgraph ==')
{
  const res = answerGraphQuestion('subgraph around Stacked LoRA for Subject-Adaptive EEG Foundation Models')
  ok('subgraph found', !!res.subgraph, res.answer.slice(0, 70))
  ok('subgraph has nodes + links', res.subgraph && Array.isArray(res.subgraph.nodes) && Array.isArray(res.subgraph.links))
  ok('subgraph root is the paper', res.subgraph && /Stacked LoRA/.test(res.subgraph.root.title))
  ok('sources populated', res.sources.length > 0, `${res.sources.length} sources`)
}

console.log('\n== 4. communities ==')
{
  const res = answerGraphQuestion('What are the communities?')
  ok('overview present', /communities/.test(res.answer))
  ok('lists multiple communities', /Neural Decoding/.test(res.answer) && /Connectomics/.test(res.answer))
}

console.log('\n== 5. bridge papers ==')
{
  const res = answerGraphQuestion('bridge papers linking research clusters')
  ok('bridge answer present', /betweenness/.test(res.answer))
  ok('lists top bridges', /1\. /.test(res.answer))
}

console.log('\n== 6. shortest path ==')
{
  const res = answerGraphQuestion('shortest path between Stacked LoRA for Subject-Adaptive EEG Foundation Models and a paper about Riemannian self-attention')
  ok('path answer present', res.answer.length > 0 && /path|edge/i.test(res.answer))
  if (res.subgraph) ok('path subgraph has nodes', res.subgraph.nodes.length >= 2)
}

console.log('\n== 7. fallback + guidance ==')
{
  const res = answerGraphQuestion('zxqj qwertyuiopvbnm')
  ok('unrecognized -> guidance', /star-map corpus|most central/.test(res.answer), res.answer.slice(0, 70))
}

console.log('\n== 8. runGraphExplorer handler ==')
{
  const ctx = { reportStatus: () => {} }
  const result = await runGraphExplorer(
    { requestParts: [{ partId: 'question', text: 'subgraph around the most central BCI paper' }] },
    ctx,
  )
  const artifacts = result.artifacts || []
  ok('answer artifact present', artifacts.some(a => a.outputId === 'answer' && typeof a.data === 'string'))

  const sub = await runGraphExplorer(
    { requestParts: [{ partId: 'question', text: 'subgraph around Stacked LoRA for Subject-Adaptive EEG Foundation Models' }] },
    ctx,
  )
  ok('subgraph artifact present', sub.artifacts.some(a => a.outputId === 'subgraph' && a.fileName === 'subgraph.json'))
  ok('subgraph artifact parses to object', (() => {
    const a = sub.artifacts.find(a => a.outputId === 'subgraph')
    if (!a) return false
    try { return typeof JSON.parse(a.data) === 'object' } catch { return false }
  })())

  let threw = false
  try {
    await runGraphExplorer({ requestParts: [] }, ctx)
  } catch (err) {
    threw = true
    ok('missing question rejected', /Missing requestParts/.test(err.message), err.message)
  }
  ok('missing question throws', threw)
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL GRAPH EXPLORER CONTRACT TESTS PASSED'}`)
process.exit(failures ? 1 : 0)
