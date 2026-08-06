// Build ada/knowledge_base.json — the ADA Protocol's grounding layer — from the
// star-map corpus (public/graph_data.json, 215 real arXiv papers).
//
// The knowledge base feeds `KnowledgeBase.search()` which is called with the
// persona's kbDomain slice (one of Psychology / Philosophy / Game Theory) and
// requires >= 2 token matches. So every seeded paper is classified into one of
// those three domains — otherwise the domain filter would make it unreachable
// and LLM_FALLBACK would stay the norm. The original 5 sample entries are
// preserved verbatim at the head of the file (they're the ADA hallmarks and
// the tests reference them); corpus entries are appended after.
//
// Usage:  node scripts/build-ada-kb.js
// Output: ada/knowledge_base.json
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CORPUS = path.join(__dirname, '..', 'public', 'graph_data.json')
const OUT = path.join(__dirname, '..', 'ada', 'knowledge_base.json')

// Domain keyword sets. A paper's domain = the set with the most hits in its
// lowercased title+abstract; ties break Game Theory > Philosophy > Psychology
// (the corpus is brain science, so Psychology is the umbrella default).
// `security`-flavored attacks land in Game Theory (adversary-vs-defender),
// while `privacy`/neuroethics land in Philosophy.
const DOMAINS = {
  'Game Theory': [
    'adversarial', 'attack', 'attacks', 'federated', 'gan', 'generative adversarial',
    'poisoning', 'backdoor', 'evasion', 'defense', 'defence', 'robust', 'robustness',
    'incentive', 'incentives', 'multi-agent', 'cooperation', 'cooperative', 'market',
    'mechanism design', 'game theory', 'game-theoretic', 'player', 'competitive',
    'privacy-preserving', 'security', 'secure', 'threat', 'malicious', 'adversary',
    'spoof', 'eavesdrop', 'vulnerabilit', 'cyberattack', 'cyber-attack',
  ],
  Philosophy: [
    'consciousness', 'conscious', 'ethics', 'ethical', 'neuroethics', 'moral',
    'free energy', 'active inference', 'agency', 'identity',
    'sense of self', 'self-awareness', 'self-identity', 'selfhood', 'self-representation',
    'theory of mind', 'philosophy of mind', 'philosoph', 'phenomenolog',
    'neurosecurity', 'privacy', 'rights', 'personhood', 'autonomy',
    'fairness', 'trust', 'explainab', 'interpretab', 'meaning', 'posthuman',
  ],
  Psychology: [
    'emotion', 'emotional', 'affect', 'affective', 'attention', 'sleep', 'insomnia',
    'depression', 'anxiety', 'stress', 'mental health', 'neurofeedback', 'cognitive load',
    'workload', 'working memory', 'memory', 'rehabilitation', 'stroke', 'alzheimer',
    'parkinson', 'fatigue', 'mindfulness', 'meditation', 'adhd', 'motor imagery',
    'imagined speech', 'speech', 'language', 'auditory', 'visual', 'perception',
    'cognitive', 'clinical', 'therapy', 'pain', 'seizure', 'epilepsy', 'tinnitus',
    'ptsd', 'addiction', 'arousal', 'engagement', 'learning', 'training', 'skill',
    'performance',    'children', 'elderly', 'awareness', 'mind-wandering', 'bias',
    'brain-computer interface', 'bci', 'eeg', 'decoding', 'neural', 'connectivity',
    'connectome', 'connectomics',
  ],
}
const DOMAIN_PRIORITY = ['Game Theory', 'Philosophy', 'Psychology']
const DEFAULT_DOMAIN = 'Psychology'

function classify(text) {
  const hay = String(text || '').toLowerCase()
  let best = null
  let bestScore = -1
  for (const [domain, keywords] of Object.entries(DOMAINS)) {
    let score = 0
    for (const kw of keywords) if (hay.includes(kw)) score++
    if (score > bestScore || (score === bestScore && (best === null || DOMAIN_PRIORITY.indexOf(domain) < DOMAIN_PRIORITY.indexOf(best)))) {
      best = domain
      bestScore = score
    }
  }
  return bestScore > 0 ? best : DEFAULT_DOMAIN
}

const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

function makeEntry(n, domain) {
  const kws = (n.keywords || []).filter(k => typeof k === 'string' && k.length > 1)
  const topic = kws[0] ? cap(kws[0]) : n.community_label || 'Brain-Computer Interface'
  const concept = kws.slice(1, 3).map(cap).join(' / ') || 'Brain-computer interface research'
  return {
    domain,
    topic,
    concept,
    paper_title: n.title,
    year: n.year,
    abstract: n.abstract,
    url: `https://arxiv.org/abs/${n.id}`,
    arxiv: n.id,
  }
}

// Quick grounding self-check: run probe queries through the token-intersection
// search (the exact mechanism answerAdaSyndicate uses) and report how many find
// papers. Demonstrates that LLM_GROUNDED is now the norm, not LLM_FALLBACK.
function probe(entries) {
  const textOf = e => `${e.topic} ${e.concept} ${e.paper_title} ${e.abstract}`.toLowerCase()
  const search = (q, domain) => {
    const qTerms = new Set(q.toLowerCase().replace(/[,.]/g, '').split(/\s+/).filter(Boolean))
    let best = 0
    for (const e of entries) {
      if (e.domain !== domain) continue
      const pool = new Set(textOf(e).split(/\s+/).filter(Boolean))
      let score = 0
      for (const t of qTerms) if (pool.has(t)) score++
      if (score > best) best = score
    }
    return best > 1
  }
  const probes = [
    ['How can EEG neurofeedback reduce anxiety in patients?', 'Psychology'],
    ['What deep learning models classify motor imagery?', 'Psychology'],
    ['How is sleep quality decoded from EEG signals?', 'Psychology'],
    ['Are adversarial attacks a real threat to brain-computer interfaces?', 'Game Theory'],
    ['How does federated learning improve cross-subject generalization?', 'Game Theory'],
    ['What are the neuroethics of sharing private brain data?', 'Philosophy'],
    ['Does active inference explain consciousness and agency?', 'Philosophy'],
    ['How do functional connectivity networks change in stroke rehabilitation?', 'Psychology'],
  ]
  const grounded = probes.filter(([q, d]) => search(q, d)).length
  console.log(`Grounding probe: ${grounded}/${probes.length} representative queries find papers (LLM_GROUNDED norm)`)
  for (const [q, d] of probes) {
    console.log(`  [${search(q, d) ? 'GROUNDED' : 'FALLBACK'}] (${d}) ${q}`)
  }
}

function main() {
  const graph = JSON.parse(fs.readFileSync(CORPUS, 'utf8'))
  const papers = graph.nodes || []

  // Preserve the original 5 sample entries verbatim (ADA hallmarks).
  const head = JSON.parse(fs.readFileSync(OUT, 'utf8')).slice(0, 5)

  const entries = papers
    .filter(p => p.title && p.abstract && p.abstract.length >= 50)
    .map(p => makeEntry(p, classify(`${p.title} ${p.abstract}`)))

  // Deterministic order: domain group, then year desc, then title — keeps the
  // file stable for git and equal-score searches (stable sort) favor the head.
  entries.sort((a, b) => {
    const da = DOMAIN_PRIORITY.indexOf(a.domain)
    const db = DOMAIN_PRIORITY.indexOf(b.domain)
    if (da !== db) return da - db
    if (b.year !== a.year) return b.year - a.year
    return a.paper_title.localeCompare(b.paper_title)
  })

  const all = head.concat(entries)

  // Sanity: no duplicate paper titles slipped in.
  const titles = new Set(all.map(e => e.paper_title))
  const dupes = all.length - titles.size

  fs.writeFileSync(OUT, JSON.stringify(all, null, 2) + '\n')

  const byDomain = {}
  for (const e of all) byDomain[e.domain] = (byDomain[e.domain] || 0) + 1
  console.log(`Wrote ${all.length} entries to ${OUT} (${head.length} sample + ${entries.length} corpus, ${dupes} duplicate titles)`)
  console.log('Domain split:', JSON.stringify(byDomain))
  probe(all)
}

main()
