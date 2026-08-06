// Build data/datasets.json — a public-datasets directory seeded from the corpus.
//
// For every benchmark dataset in data/benchmarks.json (itself extracted from
// corpus abstracts) plus any other datasets named in the abstracts, this script
// records:
//   - id / label / task (from the benchmark seed)
//   - modality  (EEG, fMRI, fNIRS, ECoG, MEG, EMG — inferred from the abstracts
//                that mention the dataset, plus the task text)
//   - subjects / classes (parsed from the task text when present)
//   - benchmark + current best self-reported entry (from benchmarks.json)
//   - mentionedBy — corpus papers that cite/use the dataset
//   - license — "not recorded" unless stated (the corpus doesn't carry licenses;
//     the agent says so honestly instead of guessing)
//
// This is a *seed* table: values are inferred from abstracts and are best
// treated as pointers, not ground truth. Plain JSON, read fresh by the
// dataset_finder agent on every call. Human curation can refine entries.
//
// Usage:  node scripts/build-datasets.js
// Output: data/datasets.json
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CORPUS = path.join(__dirname, '..', 'public', 'graph_data.json')
const BENCH = path.join(__dirname, '..', 'data', 'benchmarks.json')
const OUT = path.join(__dirname, '..', 'data', 'datasets.json')

const MODALITIES = [
  { id: 'EEG', re: /\beeg\b|electroencephalograph/i },
  { id: 'fMRI', re: /\bfmri\b|functional\s+magnetic|blood-oxygen|bold\s+signal/i },
  { id: 'fNIRS', re: /\bfnirs\b|functional\s+near/i },
  { id: 'ECoG', re: /\becog\b|electrocorticograph|intracranial\s+eeg/i },
  { id: 'SEEG', re: /\bseeg\b|stereo-?eeg/i },
  { id: 'MEG', re: /\bmeg\b|magnetoencephalograph/i },
  { id: 'EMG', re: /\bemg\b|electromyograph/i },
]

function inferModality(texts) {
  const hay = (texts || []).join(' \u0001 ')
  const found = MODALITIES.filter(m => m.re.test(hay)).map(m => m.id)
  return found.length ? found : null
}

function parseSubjects(task) {
  const m = /(\d+)\s+subjects?/i.exec(task || '')
  return m ? Number(m[1]) : null
}

function parseClasses(task) {
  const m = /(\d+)-class|(\d+)\s*classes?/i.exec(task || '')
  return m ? Number(m[1] || m[2]) : null
}

// Extra datasets that appear in the corpus but aren't in the benchmark seed
// (no extractable performance claim). Each needs a regex + a one-line task.
const EXTRA_DATASETS = [
  {
    id: 'WBCIC-MI',
    label: 'Wearable BCI motor-imagery dataset (multi-day)',
    task: 'Motor imagery, multi-day sessions',
    metric: 'accuracy (%)',
    re: /wbcic/i,
  },
  {
    id: 'Cho2017',
    label: 'Cho2017 motor-imagery EEG dataset',
    task: 'Motor imagery, 52 participants',
    metric: 'accuracy (%)',
    re: /cho\s*2017/i,
  },
  {
    id: 'Zhou2016',
    label: 'Zhou2016 motor-imagery EEG dataset',
    task: 'Motor imagery, 4 participants',
    metric: 'accuracy (%)',
    re: /zhou\s*2016/i,
  },
  {
    id: 'Zuo2025',
    label: 'Zuo2025 clinical EEG benchmark',
    task: 'Clinical motor-imagery EEG',
    metric: 'accuracy (%)',
    re: /zuo\s*2025/i,
  },
  {
    id: 'PhysioNet EEGMMIDB',
    label: 'PhysioNet EEG Motor Movement/Imagery Database',
    task: 'Motor movement + imagery, 109 subjects',
    metric: 'accuracy (%)',
    re: /eegmmidb|eeg\s+motor\s+movement/i,
  },
]

// Per-dataset mention regexes. The naive id->regex mapping lets generic words
// (SEED, DEAP, "seizure") over-match, so every dataset gets an explicit
// pattern that mirrors the matchers the sota_tracker agent uses.
const MENTION_RES = {
  'BCI IV-2a': /bci\s*(?:competition\s*)?iv[- ]?2a|iv[- ]2a|dataset\s*2a/i,
  'BCI IV-2b': /bci\s*(?:competition\s*)?iv[- ]?2b|iv[- ]2b|dataset\s*2b/i,
  'PhysioNet MI': /physionet\s+(?:motor\s+)?imagery|physionetmi|physionet\s+mi/i,
  'OpenBMI': /openbmi/i,
  'WAY-EEG-GAL': /way.?eeg.?gal|grasp\s*force/i,
  'MOABB': /moabb/i,
  'MMIDB-BCI2000': /mmidb|bci2000/i,
  'BCI III': /bci\s*(?:competition\s*)?iii/i,
  'CHB-MIT': /chb.?mit/i,
  'TUH': /\btuh\b|temple\s+university/i,
  'DEAP': /\bdeap\b/i,
  'SEED': /\bseed\s+(?:dataset|emotion|eeg|database)\b/i,
  'WBCIC-MI': /wbcic/i,
  'Cho2017': /cho\s*2017/i,
  'Zhou2016': /zhou\s*2016/i,
  'Zuo2025': /zuo\s*2025/i,
  'PhysioNet EEGMMIDB': /eegmmidb|eeg\s+motor\s+movement/i,
}
const mentionRe = (id) => MENTION_RES[id] || new RegExp(id.replace(/[- ]/g, '[\\s-]?'), 'i')

function main() {
  const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'))
  const papers = corpus.nodes || []
  const bench = fs.existsSync(BENCH) ? JSON.parse(fs.readFileSync(BENCH, 'utf8')) : null
  const benchById = new Map((bench?.datasets || []).map(d => [d.id, d]))

  const mentions = new Map() // dataset id -> [{id, title, year, url, first_author, community_label}]
  const findMentions = (id, re) => {
    for (const p of papers) {
      const hay = `${p.title} \u0001 ${p.abstract || ''} \u0001 ${(p.keywords || []).join(' ')}`
      if (re.test(hay)) {
        if (!mentions.has(id)) mentions.set(id, [])
        mentions.get(id).push({
          id: p.id, title: p.title, year: p.year, url: p.url,
          first_author: p.first_author, community_label: p.community_label,
        })
      }
    }
  }

  const datasets = []
  for (const b of bench?.datasets || []) {
    const top = b.leaderboard?.[0] || null
    findMentions(b.id, mentionRe(b.id))
    const mentionTexts = (mentions.get(b.id) || []).map(m => `${m.title} ${papers.find(p => p.id === m.id)?.abstract || ''}`)
    datasets.push({
      id: b.id,
      label: b.label,
      task: b.task,
      modality: inferModality([b.task, ...mentionTexts]),
      subjects: parseSubjects(b.task),
      classes: parseClasses(b.task),
      channels: null, // not reliably present in the corpus — left for curation
      license: 'not recorded in corpus — check the dataset source',
      benchmark: true,
      sota: top ? {
        value: top.value,
        metric: top.metric,
        rank: top.rank,
        paperId: top.paperId,
        title: top.title,
        year: top.year,
        url: top.url,
      } : null,
      mentionedBy: (mentions.get(b.id) || []).slice(0, 8),
      mentionedCount: mentions.get(b.id)?.length || 0,
    })
  }

  // Extra datasets not in the benchmark seed.
  for (const e of EXTRA_DATASETS) {
    if (datasets.some(d => d.id === e.id)) continue
    findMentions(e.id, mentionRe(e.id))
    const mentionTexts = (mentions.get(e.id) || []).map(m => `${m.title} ${papers.find(p => p.id === m.id)?.abstract || ''}`)
    datasets.push({
      id: e.id,
      label: e.label,
      task: e.task,
      modality: inferModality([e.task, ...mentionTexts]),
      subjects: parseSubjects(e.task),
      classes: parseClasses(e.task),
      channels: null,
      license: 'not recorded in corpus — check the dataset source',
      benchmark: false,
      sota: null,
      mentionedBy: (mentions.get(e.id) || []).slice(0, 8),
      mentionedCount: mentions.get(e.id)?.length || 0,
    })
  }

  datasets.sort((a, b) => b.mentionedCount - a.mentionedCount || a.id.localeCompare(b.id))

  const out = {
    generatedAt: new Date().toISOString(),
    source: 'brain-star-map corpus (public/graph_data.json) + data/benchmarks.json',
    note: 'Seed table — dataset facts are inferred from paper abstracts and may be approximate. Modality/subjects are best-effort heuristics; licenses are not recorded in the corpus. Verify against the dataset source before citing.',
    datasetCount: datasets.length,
    datasets,
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')

  console.log(`Wrote ${datasets.length} datasets to data/datasets.json`)
  for (const d of datasets) {
    console.log(`  • ${d.id.padEnd(20)} ${d.modality ? '[' + d.modality.join(',') + '] ' : ''}${d.mentionedCount} mentions${d.sota ? `  SOTA ${d.sota.value} ${d.sota.metric}` : ''}`)
  }
}

main()
