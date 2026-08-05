// sota_tracker — a benchmark leaderboard agent for the Brain Citation Star Map.
//
// Deliberately LLM-free (like star_map_demo): it answers "what is the state of
// the art on <dataset>?" with a leaderboard seeded from the corpus abstracts
// (data/benchmarks.json), so every call costs zero model tokens.
//
//   - input  "question"  -> dataset name / leaderboard / SOTA question
//   - output "answer"    -> text/plain leaderboard (ranked self-reported results)
//   - output "sources"   -> application/json cited papers behind the numbers
//
// The seed table is read fresh from disk on every call (small, ~6 KB) and can
// be regenerated / curated without touching the handler:
//     node scripts/build-benchmarks.js
//
// Honesty guardrail: the table is auto-extracted from abstracts (self-reported
// numbers, not independently verified), so the agent says so in every answer
// and never claims an entry is the definitive global SOTA.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractQuestion } from './engine.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BENCHMARKS_PATH = path.join(__dirname, '..', '..', 'data', 'benchmarks.json')

export function loadBenchmarks() {
  if (!fs.existsSync(BENCHMARKS_PATH)) return null
  try {
    return JSON.parse(fs.readFileSync(BENCHMARKS_PATH, 'utf8'))
  } catch {
    return null
  }
}

// ---------- dataset matching ----------

// Matcher aliases are intentionally a bit looser than the seed builder's
// (a question about "seizure detection" should still reach CHB-MIT), but they
// keep a hard requirement on the dataset name for most datasets to avoid
// answering a MOABB question with SEED entries.
const ALIASES = [
  { ids: ['BCI IV-2a', 'BCI IV-2b'], re: /bci\s*(?:competition\s*)?iv/i },
  { ids: ['BCI IV-2a'], re: /2a|two.?a/i },
  { ids: ['BCI IV-2b'], re: /2b|two.?b/i },
  { ids: ['PhysioNet MI'], re: /physionet/i },
  { ids: ['OpenBMI'], re: /openbmi/i },
  { ids: ['WAY-EEG-GAL'], re: /way.?eeg.?gal|grasp\s*force/i },
  { ids: ['MOABB'], re: /moabb/i },
  { ids: ['MMIDB-BCI2000'], re: /mmidb|bci2000/i },
  { ids: ['BCI III'], re: /bci\s*(?:competition\s*)?iii/i },
  { ids: ['CHB-MIT'], re: /chb.?mit|seizure/i },
  { ids: ['TUH'], re: /\btuh\b|temple\s+university/i },
  { ids: ['DEAP'], re: /\bdeap\b|emotion\s*(?:dataset|recognition)/i },
  { ids: ['SEED'], re: /\bseed\s+(?:dataset|emotion|eeg|database)\b/ },
]

// Exact-id first (so "BCI IV-2a" doesn't hit the broader IV alias), then
// regex aliases in order. Returns dataset ids that match, or [].
export function matchDatasets(question) {
  // Normalize dashes/spaces so "BCI IV-2a" and "bci iv 2a" both resolve.
  const q = question.toLowerCase().replace(/[-_]/g, ' ')
  const bench = loadBenchmarks()
  if (!bench) return []
  const all = bench.datasets.map(d => d.id)
  const hits = []
  for (const id of all) {
    if (q.includes(id.toLowerCase().replace(/[-_]/g, ' '))) hits.push(id)
  }
  // If a specific BCI IV variant was named, the broad "BCI IV" alias would
  // add the sibling dataset too — skip it then (2a vs 2b are distinct
  // benchmarks).
  const hasSpecificIv = hits.some(id => id === 'BCI IV-2a' || id === 'BCI IV-2b')
  for (const alias of ALIASES) {
    if (hasSpecificIv && alias.ids.length > 1 && /iv/i.test(alias.ids[0])) continue
    if (alias.re.test(q)) {
      for (const id of alias.ids) {
        if (!hits.includes(id) && all.includes(id)) hits.push(id)
      }
    }
  }
  return hits
}

// ---------- answer formatting ----------

function formatEntry(e) {
  const v = Number(e.value)
  const val = e.metric === 'accuracy (%)' ? v.toFixed(1) + '%' : `${v.toFixed(e.round ?? 3)} ${e.metric}`
  return `#${e.rank}  ${val}  ${e.title} (${e.firstAuthor || '?'}, ${e.year})`
}

export function answerSotaQuestion(question) {
  const bench = loadBenchmarks()
  if (!bench) {
    return {
      answer: 'The benchmark leaderboard is not available right now (data/benchmarks.json missing).',
      sources: [],
    }
  }

  const q = question.toLowerCase()
  const wanted = matchDatasets(question)
  const wantsOverview = /(all|overview|every|list|summary|what.*benchmark|datasets)/.test(q) &&
    !/(:?\bon|:?\bfor)\s+[\w -]+$/.test(q)

  // Case 1: explicit dataset(s) named -> show each leaderboard.
  if (wanted.length) {
    const lines = []
    const sources = []
    for (const id of wanted) {
      const ds = bench.datasets.find(d => d.id === id)
      if (!ds) continue
      lines.push(`${ds.label} — ${ds.task}`)
      if (!ds.leaderboard.length) {
        lines.push('  (no verified entries in the seed table yet)')
        continue
      }
      for (const e of ds.leaderboard) {
        lines.push('  ' + formatEntry(e))
        sources.push({ title: e.title, year: e.year, url: e.url })
      }
      lines.push('')
    }
    if (!lines.length) {
      return {
        answer: `No benchmark entries found for "${question}". Try "BCI IV-2a", "PhysioNet", or "all benchmarks".`,
        sources: [],
      }
    }
    return {
      answer:
        `Benchmark leaderboard (seeded from corpus abstracts — self-reported numbers, not independently verified):\n\n` +
        lines.join('\n').trim() +
        `\n\nSeed: ${bench.totalClaims} claims across ${bench.datasetCount} datasets (data/benchmarks.json).`,
      sources,
    }
  }

  // Case 2: overview of every dataset with its current top entry.
  if (wantsOverview || /\b(leaderboard|sota|state of the art|top|best)\b/.test(q)) {
    const lines = ['State-of-the-art overview (top self-reported result per dataset):', '']
    const sources = []
    for (const ds of bench.datasets) {
      const top = ds.leaderboard[0]
      if (!top) continue
      lines.push(`  ${ds.id.padEnd(18)} ${formatEntry(top)}`)
      sources.push({ title: top.title, year: top.year, url: top.url })
    }
    if (lines.length === 2) {
      return {
        answer: 'No benchmark entries are seeded yet. Run `node scripts/build-benchmarks.js` to regenerate the table.',
        sources: [],
      }
    }
    return {
      answer:
        lines.join('\n') +
        `\n\nAll numbers are self-reported from paper abstracts (data/benchmarks.json) — verify against the paper before citing as definitive SOTA. Ask about a specific dataset (e.g. "SOTA on BCI IV-2a") for the full ranked list.`,
      sources,
    }
  }

  // Case 3: didn't understand -> point at what's available.
  const dsNames = bench.datasets.filter(d => d.entryCount > 0).map(d => d.id).join(', ')
  return {
    answer:
      `I can answer SOTA / leaderboard questions from the corpus benchmark seed table.\n\n` +
      `Datasets with entries: ${dsNames}.\n\n` +
      `Try: "What is the state of the art on BCI IV-2a?", "MOABB leaderboard", "best accuracy on OpenBMI", or "all benchmarks".`,
    sources: [],
  }
}

export async function runSotaTracker(task, ctx) {
  const question = extractQuestion(task)

  ctx?.reportStatus('sota_tracker: reading the benchmark leaderboard (no LLM)…')

  const { answer, sources } = answerSotaQuestion(question)

  const artifacts = [{ data: answer, mimeType: 'text/plain', outputId: 'answer' }]
  if (sources.length) {
    artifacts.push({
      data: JSON.stringify(sources, null, 2),
      mimeType: 'application/json',
      outputId: 'sources',
      fileName: 'sources.json',
    })
  }
  return { artifacts }
}
