// dataset_finder — research question -> matching public datasets.
//
// LLM-free (like sota_tracker / graph_explorer): answers "which dataset should
// I use for X?" from data/datasets.json — a directory seeded from the corpus
// (see scripts/build-datasets.js). Every call is instant and costs zero model
// tokens.
//
//   - input  "question"  -> which/what dataset for <task>? or <dataset id> details
//   - output "answer"    -> text/plain ranked dataset cards (modality, task,
//                           subjects/classes, license, benchmark SOTA)
//   - output "sources"   -> application/json the corpus papers that use/mention
//                           each dataset
//
// Honesty guardrail: the directory is seeded from paper abstracts (modality and
// subject counts are best-effort heuristics; licenses are not recorded in the
// corpus), so the agent labels it as a seed table and never claims verified
// facts. Regenerate / curate data/datasets.json without touching the handler.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractQuestion } from './engine.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATASETS_PATH = path.join(__dirname, '..', '..', 'data', 'datasets.json')

export function loadDatasets() {
  if (!fs.existsSync(DATASETS_PATH)) return null
  try {
    return JSON.parse(fs.readFileSync(DATASETS_PATH, 'utf8'))
  } catch {
    return null
  }
}

// ---------- matching ----------

// Topic aliases: when the question describes a task/modality rather than naming
// a dataset, these add the datasets that benchmark that task. Keep it honest —
// these mirror the benchmark seed's own task descriptions.
const TOPIC_ALIASES = [
  { ids: ['BCI IV-2a', 'BCI IV-2b', 'PhysioNet MI', 'OpenBMI', 'MOABB', 'WBCIC-MI', 'Cho2017', 'Zhou2016', 'Zuo2025'], re: /motor\s*imagery|\bmi\b|motor\s+imagination/i },
  { ids: ['WAY-EEG-GAL'], re: /grasp\s*force|force\s*decod|kinematic|kinetic/i },
  { ids: ['CHB-MIT', 'TUH'], re: /seizure|epilep/i },
  { ids: ['DEAP', 'SEED'], re: /emotion|affective/i },
  { ids: ['BCI III', 'PhysioNet MI'], re: /imagined\s*speech|speech\s*decod/i },
  { ids: ['TUH', 'PhysioNet EEGMMIDB'], re: /clinical|eeg\s*database|long.?term/i },
  { ids: ['MOABB', 'PhysioNet MI'], re: /cross.?subject|benchmark|comparison|reproducib/i },
  { ids: ['MMIDB-BCI2000', 'BCI III'], re: /competition|benchmark/i },
]

// Token overlap of the question against a dataset's searchable text
// (id + label + task + modality). Used as the primary ranking signal.
function tokenScore(q, d) {
  const tokens = q.split(/\s+/).filter(t => t.length > 2)
  if (!tokens.length) return 0
  const hay = `${d.id} ${d.label} ${d.task} ${(d.modality || []).join(' ')}`.toLowerCase()
  let s = 0
  for (const t of tokens) {
    if (hay.includes(t)) s += 1
  }
  return s
}

// Return { dataset, score, named } — named=true when the question explicitly
// names the dataset id/label (takes priority over topic scoring).
export function matchDatasetsForQuestion(question) {
  const dir = loadDatasets()
  if (!dir) return []
  const q = question.toLowerCase().replace(/[-_]/g, ' ')
  const all = dir.datasets

  const named = all.filter(d => {
    const id = d.id.toLowerCase().replace(/[-_]/g, ' ')
    const label = d.label.toLowerCase()
    return q.includes(id) || (label.length > 6 && q.includes(label))
  })

  // Topic-alias hits (task descriptions, not names).
  const aliasHits = []
  for (const a of TOPIC_ALIASES) {
    if (a.re.test(q)) {
      for (const id of a.ids) {
        const d = all.find(x => x.id === id)
        if (d && !aliasHits.includes(d) && !named.includes(d)) aliasHits.push(d)
      }
    }
  }

  // Generic token scoring for "dataset for X" questions.
  const scored = all
    .map(d => ({ dataset: d, score: tokenScore(q, d), named: false }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)

  const results = [
    ...named.map(d => ({ dataset: d, score: 100, named: true })),
    ...aliasHits.map(d => ({ dataset: d, score: 50, named: false })),
    ...scored.filter(r => !named.includes(r.dataset) && !aliasHits.includes(r.dataset)),
  ]
  // Dedupe by id, keep the best score.
  const seen = new Set()
  return results.filter(r => {
    if (seen.has(r.dataset.id)) return false
    seen.add(r.dataset.id)
    return true
  })
}

// ---------- answer formatting ----------

function formatSota(sota) {
  if (!sota) return 'no benchmark entry seeded'
  const v = Number(sota.value)
  const val = sota.metric === 'accuracy (%)' ? v.toFixed(1) + '%' : `${v.toFixed(3)} ${sota.metric}`
  return `best self-reported: ${val} — ${sota.title} (${sota.year})`
}

function formatCard(d) {
  const lines = [
    `${d.id} — ${d.label}`,
    `  Task: ${d.task || 'not recorded'}`,
  ]
  const bits = []
  if (d.modality?.length) bits.push(`modality: ${d.modality.join('/')}`)
  if (d.subjects) bits.push(`${d.subjects} subjects`)
  if (d.classes) bits.push(`${d.classes} classes`)
  if (d.channels) bits.push(`${d.channels} channels`)
  if (bits.length) lines.push('  ' + bits.join(' · '))
  lines.push(`  License: ${d.license || 'not recorded'}`)
  lines.push(`  Benchmark: ${d.benchmark ? 'yes — ' + formatSota(d.sota) : 'no (in corpus, no seeded SOTA)'}`)
  if (d.mentionedCount) {
    lines.push(`  Used/mentioned by ${d.mentionedCount} corpus paper(s)`)
  }
  return lines.join('\n')
}

export function answerDatasetQuestion(question) {
  const dir = loadDatasets()
  if (!dir) {
    return { answer: 'The datasets directory is not available right now (data/datasets.json missing).', sources: [] }
  }
  const q = question.toLowerCase()

  // Overview: "all datasets" / "list datasets" / "datasets directory".
  if (/\b(all|every|list|overview|directory|catalog|what datasets)\b/.test(q)) {
    const lines = dir.datasets.map(d =>
      `- ${d.id.padEnd(18)} ${d.modality ? '[' + d.modality.join(',') + '] ' : ''}${d.task || ''}${d.sota ? `  → ${formatSota(d.sota)}` : ''}`
    )
    return {
      answer:
        `Public datasets directory (seeded from the ${dir.datasetCount}-entry corpus table — inferred from abstracts, verify before citing):\n\n` +
        lines.join('\n') +
        `\n\nAsk \"which dataset for motor imagery?\" or \"details on BCI IV-2a\" for full cards.`,
      sources: [],
    }
  }

  const matched = matchDatasetsForQuestion(question)

  // Explicit dataset(s) named -> full card(s).
  if (matched.length) {
    const top = matched.filter(r => r.named).length ? matched.filter(r => r.named) : matched.slice(0, 3)
    const cards = top.map(r => formatCard(r.dataset))
    const sources = []
    for (const r of top) {
      for (const m of r.dataset.mentionedBy || []) {
        sources.push({ title: m.title, year: m.year, url: m.url, dataset: r.dataset.id })
      }
    }
    const rankNote = matched.filter(r => !r.named).length
      ? `\n\nAlso relevant: ${matched.filter(r => !r.named).slice(0, 3).map(r => r.dataset.id).join(', ')}.`
      : ''
    return {
      answer:
        `Datasets matching "${question}" (seed table from corpus abstracts — modality/subjects are heuristics, verify against the source):\n\n` +
        cards.join('\n\n') + rankNote,
      sources: sources.slice(0, 12),
    }
  }

  // Nothing matched -> point at what's available.
  const ids = dir.datasets.slice(0, 12).map(d => d.id).join(', ')
  return {
    answer:
      `I can find public datasets for brain-tech research from the corpus seed directory.\n\n` +
      `Datasets on file: ${ids}${dir.datasets.length > 12 ? ', …' : ''}.\n\n` +
      `Try: "Which dataset for motor imagery?", "dataset for seizure detection", "details on WAY-EEG-GAL", or "all datasets".`,
    sources: [],
  }
}

// ---------- handler ----------

export async function runDatasetFinder(task, ctx) {
  const question = extractQuestion(task)

  ctx?.reportStatus('dataset_finder: matching datasets from the corpus directory (no LLM)…')

  const { answer, sources } = answerDatasetQuestion(question)

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
