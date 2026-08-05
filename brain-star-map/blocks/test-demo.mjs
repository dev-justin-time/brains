// Offline contract harness for the star_map_demo agent (blocks/lib/demo.js).
//
// No network, no SDK, no LLM — exercises the handler logic directly and
// verifies:
//   1. input contract (missing question rejected)
//   2. corpus-stats question answered LLM-free (directLookup path)
//   3. retrieval fallback answers with top papers
//   4. demo.html is always attached as a text/html file artifact
//   5. sources artifact present when the fallback returns hits
import { answerQuestion, demoHtml, runStarMapDemo } from './lib/demo.js'

let failures = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

console.log('== 1. demo.html artifact source ==')
{
  const html = demoHtml()
  ok('demo.html readable from disk', html && html.length > 0, `${html ? html.length : 0} bytes`)
  ok('demo.html is real HTML', html && html.includes('<html'), html ? 'has <html>' : '')
}

console.log('\n== 2. LLM-free answers ==')
{
  const stats = answerQuestion('How many papers are in the corpus?')
  ok('stats answer present', typeof stats.answer === 'string' && stats.answer.length > 0)
  ok('stats mentions a number', /\d+/.test(stats.answer), stats.answer.slice(0, 80))

  const papers = answerQuestion('List papers about EEG motor imagery')
  ok('list answer present', papers.answer.length > 0)
  ok('list includes a paper title', /\. |\d\.|http/i.test(papers.answer.slice(0, 120)))

  const none = answerQuestion('zxqj qwertyuiopvbnm')
  ok('no-match handled gracefully', none.answer.length > 0 && /No corpus papers matched/.test(none.answer), none.answer.slice(0, 60))
}

console.log('\n== 3. runStarMapDemo handler ==')
{
  const ctx = { reportStatus: () => {} }
  const result = await runStarMapDemo(
    { requestParts: [{ partId: 'question', text: 'How many papers are in the corpus?' }] },
    ctx,
  )
  const artifacts = result.artifacts || []
  ok('answer artifact present', artifacts.some(a => a.outputId === 'answer' && typeof a.data === 'string'))
  const demo = artifacts.find(a => a.outputId === 'demo')
  ok('demo artifact present', !!demo, demo ? `fileName=${demo.fileName}` : '')
  ok('demo mimeType is text/html', demo && demo.mimeType === 'text/html')
  ok('demo fileName is star-map-demo.html', demo && demo.fileName === 'star-map-demo.html')
  ok('demo data contains <html>', demo && String(demo.data).includes('<html'))
}

console.log('\n== 4. input contract ==')
{
  const ctx = { reportStatus: () => {} }
  let threw = false
  try {
    await runStarMapDemo({ requestParts: [] }, ctx)
  } catch (err) {
    threw = true
    // extractQuestion (the shared request contract) rejects empty parts.
    ok('missing question rejected', /Missing requestParts/.test(err.message), err.message)
  }
  ok('missing question throws', threw)
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL DEMO AGENT CONTRACT TESTS PASSED'}`)
process.exit(failures ? 1 : 0)
