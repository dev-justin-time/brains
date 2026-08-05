// Build the expert-agent database from public/graph_data.json.
//
//   node scripts/build-agent-db.js            # full build + pre-warm cache
//   node scripts/build-agent-db.js --no-warm  # index only, skip LLM pre-warm
//   node scripts/build-agent-db.js --warm-limit 3   # pre-warm only the first 3 popular questions
//
// Requires Ollama running with an embedding model (default: nomic-embed-text).
// If no embedding model is available, the index falls back to keyword-only search.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { upsertPapers, setMeta, cacheGet, dbStats, clearEmbeddings } from '../server/db.js'
import { storeEmbedding, loadEmbedding } from '../server/db.js'
import { embed, listModels, hasModel, CHAT_MODEL, EMBED_MODEL } from '../server/ollama.js'
import { loadIndex } from '../server/search.js'
import { ask } from '../server/agents.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_PATH = path.join(__dirname, '..', 'public', 'graph_data.json')

// Questions pre-warmed into the cache so they answer instantly (0 model calls at runtime).
const POPULAR_QUESTIONS = [
  'What is a brain-computer interface?',
  'How does EEG motor imagery decoding work?',
  'What is connectomics?',
  'What are the main approaches to neural decoding?',
  'How is deep learning used in EEG analysis?',
  'What is the difference between EEG and fMRI?',
  'What is a spiking neural network?',
  'How are brain signals decoded for rehabilitation?',
  'What is transfer learning in BCI research?',
  'What is the role of transformers in neural decoding?',
  'What are the clinical applications of brain-computer interfaces?',
  'How do graph neural networks help analyze brain networks?',
]

function parseFlags() {
  const args = process.argv.slice(2)
  return {
    noWarm: args.includes('--no-warm'),
    warmLimit: (() => {
      const i = args.indexOf('--warm-limit')
      return i >= 0 ? parseInt(args[i + 1], 10) : null
    })(),
  }
}

async function main() {
  const flags = parseFlags()
  const t0 = Date.now()

  if (!fs.existsSync(DATA_PATH)) {
    console.error(`Data file not found: ${DATA_PATH}\nRun \`npm run data\` first.`)
    process.exit(1)
  }

  const graph = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'))
  console.log(`Loaded ${graph.nodes.length} papers, ${graph.links.length} edges from graph_data.json`)

  // 1. Papers
  upsertPapers(graph.nodes)
  setMeta('total_edges', graph.links.length)
  setMeta('built_at', new Date().toISOString())
  console.log(`Indexed papers. DB stats: ${JSON.stringify(dbStats())}`)

  // 2. Embeddings (best effort)
  const models = await listModels()
  const embedReady = await hasModel(EMBED_MODEL)
  if (embedReady) {
    console.log(`Embedding ${graph.nodes.length} papers with "${EMBED_MODEL}"…`)
    clearEmbeddings()
    let done = 0
    const CONCURRENCY = 4
    const queue = [...graph.nodes]
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const p = queue.shift()
        const existing = loadEmbedding(p.id)
        if (existing && existing.model === EMBED_MODEL) { done++; continue }
        const text = `${p.title}\n${(p.keywords || []).join(', ')}\n${(p.abstract || '').slice(0, 1200)}`
        const vec = await embed(text)
        if (vec) storeEmbedding(p.id, EMBED_MODEL, vec)
        done++
        if (done % 25 === 0 || done === graph.nodes.length) {
          process.stdout.write(`\r  embedded ${done}/${graph.nodes.length}`)
        }
      }
    })
    await Promise.all(workers)
    process.stdout.write('\n')
  } else {
    console.warn(`Embedding model "${EMBED_MODEL}" not available in Ollama.`)
    console.warn(`Vector search disabled — keyword-only mode. Run: ollama pull ${EMBED_MODEL}`)
  }
  setMeta('embed_model', embedReady ? EMBED_MODEL : null)

  // 3. Reload in-memory index
  loadIndex()
  console.log(`Index ready: ${JSON.stringify({ papers: graph.nodes.length, ...dbStats() })}`)

  // 4. Pre-warm popular Q&A
  if (flags.noWarm) {
    console.log('Skipping popular-question pre-warm (--no-warm)')
  } else if (!(await hasModel(CHAT_MODEL))) {
    console.warn(`Chat model "${CHAT_MODEL}" not available — skipping pre-warm. Run: ollama pull ${CHAT_MODEL}`)
  } else {
    const list = flags.warmLimit != null ? POPULAR_QUESTIONS.slice(0, flags.warmLimit) : POPULAR_QUESTIONS
    console.log(`Pre-warming ${list.length} popular questions (cache hits will be instant, 0 model calls)…`)
    for (let i = 0; i < list.length; i++) {
      const q = list[i]
      if (cacheGet(q)) { console.log(`  [${i + 1}/${list.length}] cached already: "${q}"`); continue }
      process.stdout.write(`  [${i + 1}/${list.length}] "${q}" … `)
      try {
        const r = await ask(q, { stream: false })
        console.log(`done (${r.modelCalls} chat call${r.modelCalls === 1 ? '' : 's'}, ${Math.round(r.durationMs / 1000)}s)`)
      } catch (e) {
        console.log(`failed: ${e.message}`)
      }
    }
  }

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.`)
  console.log('Start the server: npm run serve')
  console.log(`  - /api/health    status + model readiness`)
  console.log(`  - POST /api/ask  {"question": "…", "stream": true}`)
  console.log(`  - /api/popular   top cached questions (instant answers)`)
}

main().catch(e => { console.error(e); process.exit(1) })
