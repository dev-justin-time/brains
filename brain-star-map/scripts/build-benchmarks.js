// Build data/benchmarks.json — a benchmark leaderboard seeded from the corpus.
//
// Scans every paper abstract in public/graph_data.json for known BCI/EEG
// benchmark datasets and extracts self-reported performance claims (accuracy,
// F1, R², kappa) so the sota_tracker agent can answer "what's the state of the
// art on X?" without any LLM call.
//
// This is a *seed* table: claims are extracted automatically from abstracts,
// which can be noisy. Human curation can refine entries afterwards — the file
// is plain JSON and the agent reads it fresh from disk on every call.
//
// Usage:  node scripts/build-benchmarks.js
// Output: data/benchmarks.json
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CORPUS = path.join(__dirname, '..', 'public', 'graph_data.json')
const OUT = path.join(__dirname, '..', 'data', 'benchmarks.json')

// Known benchmark datasets + how they appear in abstracts (regex on lowercased text).
const DATASETS = [
  {
    id: 'BCI IV-2a',
    label: 'BCI Competition IV dataset 2a',
    task: 'Motor imagery, 4-class (L/R/hands/feet+tongue), 9 subjects',
    metric: 'accuracy (%)',
    re: /bci\s*(?:competition\s*)?iv[- ]?2a|iv[- ]2a|dataset\s*2a|bci.?iv.?2a/,
  },
  {
    id: 'BCI IV-2b',
    label: 'BCI Competition IV dataset 2b',
    task: 'Motor imagery, 2-class (L/R hand), 9 subjects',
    metric: 'accuracy (%)',
    re: /bci\s*(?:competition\s*)?iv[- ]?2b|iv[- ]2b|dataset\s*2b|bci.?iv.?2b/,
  },
  {
    id: 'PhysioNet MI',
    label: 'PhysioNet Motor Imagery (PhysionetMI)',
    task: 'Motor imagery, 2-class, 109 subjects',
    metric: 'accuracy (%)',
    re: /physionet|physionetmi/,
  },
  {
    id: 'OpenBMI',
    label: 'OpenBMI dataset',
    task: 'Motor imagery, 2-class, 54 subjects',
    metric: 'accuracy (%)',
    re: /openbmi/,
  },
  {
    id: 'WAY-EEG-GAL',
    label: 'WAY-EEG-GAL grasp force dataset',
    task: 'Grasp force decoding, 12 subjects',
    metric: 'R²',
    re: /way[- ]?eeg[- ]?gal|way\s+eeg\s+gal/,
  },
  {
    id: 'MOABB',
    label: 'MOABB (Mother of All BCI Benchmarks)',
    task: 'Cross-dataset motor-imagery benchmark suite',
    metric: 'accuracy (%)',
    re: /moabb/,
  },
  {
    id: 'MMIDB-BCI2000',
    label: 'MMIDB-BCI2000',
    task: 'Motor imagery, multi-subject BCI2000 collection',
    metric: 'accuracy (%)',
    re: /mmidb[- ]?bci2000|bci2000/,
  },
  {
    id: 'BCI III',
    label: 'BCI Competition III',
    task: 'Imagined speech / motor imagery',
    metric: 'accuracy (%)',
    re: /bci\s*(?:competition\s*)?iii/,
  },
  {
    id: 'CHB-MIT',
    label: 'CHB-MIT scalp EEG (seizure)',
    task: 'Seizure detection',
    metric: 'accuracy (%)',
    re: /chb[- ]?mit/,
  },
  {
    id: 'TUH',
    label: 'Temple University Hospital EEG',
    task: 'EEG classification',
    metric: 'accuracy (%)',
    re: /\btuh\b|temple\s+university/,
  },
  {
    id: 'DEAP',
    label: 'DEAP emotion dataset',
    task: 'Affective EEG classification',
    metric: 'accuracy (%)',
    re: /\bdeap\b/,
  },
  {
    id: 'SEED',
    label: 'SEED emotion dataset',
    task: 'Affective EEG classification',
    metric: 'accuracy (%)',
    re: /\bseed\b/,
  },
]

// Metric claim patterns — look for a number near a metric word.
const METRIC_PATTERNS = [
  { metric: 'accuracy (%)', valueRe: /(\d{2}(?:\.\d+)?)\s*%/, wordRe: /accurac/i, round: 1 },
  { metric: 'F1', valueRe: /(0\.\d{2,3}|9[0-9](?:\.\d+)?)\s*%?\s*F1|\bF1[^0-9]{0,15}(0\.\d{2,3})/i, wordRe: /\bf1\b|f1.?score/i, round: 3 },
  { metric: 'R²', valueRe: /R\s*[²^2]\s*=\s*(0\.\d+)/, wordRe: /r\s*[²^2]|r.?squared/i, round: 3 },
  { metric: 'kappa', valueRe: /\bkappa\b[^0-9]{0,15}(0\.\d+)/i, wordRe: /kappa/i, round: 3 },
]

// Sanity bounds — drop implausible extractions (p-values, tiny numbers that are
// clearly not the claimed metric, below-chance accuracies) so the leaderboard
// seed stays honest. Ranges chosen per metric:
//   accuracy 50–100% (chance is usually 25–50%), F1 0.5–1, kappa 0.3–1, R² 0–1.
const IN_RANGE = {
  'accuracy (%)': v => v >= 50 && v <= 100,
  F1: v => v >= 0.5 && v <= 1,
  kappa: v => v >= 0.3 && v <= 1,
  'R²': v => v >= 0 && v <= 1,
}

function extractClaim(abstract) {
  const a = abstract || ''
  // accuracy: "86.32% accuracy" or "accuracy of 86.32%"
  const acc = a.match(/(\d{2}(?:\.\d+)?)\s*%\s*(?:classification\s+)?(?:test\s+)?accurac/i) ||
    a.match(/accurac(?:y|ies)\s*(?:of|:)?\s*(\d{2}(?:\.\d+)?)\s*%/i)
  if (acc && IN_RANGE['accuracy (%)'](parseFloat(acc[1]))) {
    return { metric: 'accuracy (%)', value: parseFloat(acc[1]), round: 1 }
  }
  const r2 = a.match(/R\s*\^?\s*[²2]?\s*\$?\s*=\s*\$?\s*(0\.\d+)/i) || a.match(/R\s*\^?\s*[²2]?\s*\$?\s*of\s*\$?\s*(0\.\d+)/i)
  if (r2 && IN_RANGE['R²'](parseFloat(r2[1]))) {
    return { metric: 'R²', value: parseFloat(r2[1]), round: 3 }
  }
  const f1 = a.match(/\bF1\b[^0-9]{0,15}(0\.\d{2,3})/i) || a.match(/(0\.\d{2,3})\s*F1/i)
  if (f1 && IN_RANGE.F1(parseFloat(f1[1]))) {
    return { metric: 'F1', value: parseFloat(f1[1]), round: 3 }
  }
  const kap = a.match(/\bkappa\b[^0-9]{0,15}(0\.\d+)/i)
  if (kap && IN_RANGE.kappa(parseFloat(kap[1]))) {
    return { metric: 'kappa', value: parseFloat(kap[1]), round: 3 }
  }
  return null
}

function main() {
  const graph = JSON.parse(fs.readFileSync(CORPUS, 'utf8'))
  const papers = graph.nodes || []

  // datasetId -> entries[]
  const byDataset = {}
  for (const ds of DATASETS) byDataset[ds.id] = []

  for (const p of papers) {
    const text = (p.abstract || '').toLowerCase()
    if (!text) continue
    for (const ds of DATASETS) {
      if (!ds.re.test(text)) continue
      const claim = extractClaim(p.abstract)
      if (!claim) continue
      byDataset[ds.id].push({
        paperId: p.id,
        title: p.title,
        year: p.year,
        url: p.url,
        firstAuthor: p.first_author,
        metric: claim.metric,
        value: claim.value,
      })
    }
  }

  const datasets = []
  for (const ds of DATASETS) {
    const entries = byDataset[ds.id]
      .sort((a, b) => b.value - a.value)
      .slice(0, 10) // top 10 per dataset
    datasets.push({
      id: ds.id,
      label: ds.label,
      task: ds.task,
      metric: ds.metric,
      entryCount: entries.length,
      leaderboard: entries.map((e, i) => ({ rank: i + 1, ...e })),
    })
  }

  const total = datasets.reduce((s, d) => s + d.entryCount, 0)
  const out = {
    generatedAt: new Date().toISOString(),
    source: 'brain-star-map corpus (public/graph_data.json), auto-extracted from abstracts',
    note: 'Seed table — values are self-reported numbers extracted from paper abstracts and may be approximate. Verify against the paper before citing as definitive SOTA.',
    datasetCount: datasets.length,
    totalClaims: total,
    datasets,
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
  console.log(`Wrote ${total} benchmark claims across ${datasets.length} datasets to ${OUT}`)
  for (const d of datasets) {
    console.log(`  ${d.id.padEnd(18)} ${String(d.entryCount).padStart(2)} entries  (top: ${d.leaderboard[0] ? d.leaderboard[0].value + ' ' + d.metric : '—'})`)
  }
}

main()
