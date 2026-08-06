import fs from 'fs'
import path from 'path'

const OUT = path.join(process.cwd(), 'public', 'graph_data.json')

// Seed the build from the previously generated corpus (if present) so a
// refresh unions fresh arXiv results with the existing papers instead of
// replacing them — keeps the corpus rich while updating stats.
function loadExistingPapers() {
  try {
    const existing = JSON.parse(fs.readFileSync(OUT, 'utf8'))
    const nodes = existing.nodes || []
    if (!Array.isArray(nodes) || nodes.length === 0) return []
    return nodes.map(n => ({
      id: n.id,
      title: n.title || '',
      authors: n.authors || [],
      abstract: n.abstract || '',
      published: n.published || '',
      url: n.url || '',
      keywords: Array.isArray(n.keywords) ? n.keywords : extractKeywords((n.title || '') + ' ' + (n.abstract || '')),
    }))
  } catch {
    return []
  }
}

const TOPICS = [
  { q: 'brain computer interface EEG', max: 50 },
  { q: 'brainwave decoding machine learning', max: 30 },
  { q: 'brain computer interface security privacy', max: 30 },
  { q: 'connectomics network neuroscience', max: 40 },
  { q: 'EEG motor imagery deep learning', max: 40 },
  { q: 'neural decoding fMRI', max: 40 },
  { q: 'brain computer interface review', max: 30 },
  { q: 'EEG signal processing deep learning', max: 30 },
  { q: 'brain network graph neural network', max: 30 },
]

const KEYWORDS = [
  'eeg','fmri','bci','brain-computer','decoding','neural','deep learning','cnn',
  'transformer','connectome','connectomics','security','privacy','adversarial',
  'federated','motor imagery','seizure','epilepsy','depression','rehabilitation',
  'spiking','snn','gnn','graph neural','functional connectivity','structural connectivity',
  'brain network','visual decoding','language decoding','imagined speech','p300',
  'ssvep','erp','artifact','denoising','transfer learning','foundation model',
  'neurofeedback','prosthetics','wheelchair','emotion','attention','sleep',
  'alzheimer','stroke','clinical','therapy','neurosecurity','threat','attack',
  'privacy-preserving','synthetic data','diffusion','llm','large language model',
  'multimodal','cross-subject','generalization','calibration','real-time',
  'neuromorphic','embedded','wearable','implantable','invasive','non-invasive'
]

function extractKeywords(text) {
  const t = text.toLowerCase()
  return KEYWORDS.filter(k => t.includes(k))
}

async function fetchArxiv(query, maxResults) {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`
  const res = await fetch(url)
  const xml = await res.text()
  const entries = []
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let m
  while ((m = entryRegex.exec(xml)) !== null) {
    const entry = m[1]
    const get = (tag) => {
      const r = new RegExp(`<${tag}>([^]*?)<\/${tag}>`)
      const x = r.exec(entry)
      return x ? x[1].trim() : ''
    }
    const idMatch = /<id>([\s\S]*?)<\/id>/.exec(entry)
    const id = idMatch ? idMatch[1].split('/').pop() : Math.random().toString(36).slice(2)
    const title = get('title').replace(/\s+/g, ' ')
    const summary = get('summary').replace(/\s+/g, ' ')
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(x => x[1])
    const published = get('published')
    const pdf = `https://arxiv.org/pdf/${id}.pdf`
    entries.push({ id, title, authors, abstract: summary, published, url: pdf, keywords: extractKeywords(title + ' ' + summary) })
  }
  return entries
}

function getFirstAuthor(authors) {
  if (Array.isArray(authors)) return authors[0] || 'Unknown'
  if (typeof authors === 'string') return authors.split(',')[0] || 'Unknown'
  return 'Unknown'
}

function buildGraph(papers) {
  const byId = new Map()
  papers.forEach(p => byId.set(p.id, p))
  const uniq = Array.from(byId.values())

  const edges = []
  const degrees = new Map()
  for (let i = 0; i < uniq.length; i++) {
    degrees.set(uniq[i].id, 0)
    for (let j = i + 1; j < uniq.length; j++) {
      const a = new Set(uniq[i].keywords)
      const b = new Set(uniq[j].keywords)
      const shared = [...a].filter(x => b.has(x))
      if (shared.length >= 2) {
        const w = shared.length
        edges.push({ source: uniq[i].id, target: uniq[j].id, weight: w, shared_keywords: shared })
        degrees.set(uniq[i].id, (degrees.get(uniq[i].id) || 0) + w)
        degrees.set(uniq[j].id, (degrees.get(uniq[j].id) || 0) + w)
      }
    }
  }

  edges.sort((a, b) => b.weight - a.weight)
  const topEdges = edges.slice(0, 700)

  const deg2 = new Map()
  uniq.forEach(p => deg2.set(p.id, 0))
  topEdges.forEach(e => {
    deg2.set(e.source, (deg2.get(e.source) || 0) + e.weight)
    deg2.set(e.target, (deg2.get(e.target) || 0) + e.weight)
  })

  // Curated topic taxonomy for community labelling (restores the
  // BCI & EEG / Neural Decoding / Connectomics / ... labels the corpus shipped with).
  const TOPIC_RULES = [
    { id: 'BCI_EEG', label: 'BCI & EEG', words: ['eeg','bci','brain-computer','brain computer','motor imagery','ssvep','p300','erp','neurofeedback','wheelchair','prosthetics','cortico','brainwave','emg','eog','invasive','non-invasive'] },
    { id: 'NEURAL_DECODING', label: 'Neural Decoding', words: ['decoding','decoder','visual decoding','language decoding','imagined speech','neural decoding','reconstruction','semantic decoding','speech decoding'] },
    { id: 'CONNECTOMICS', label: 'Connectomics', words: ['connectome','connectomics','functional connectivity','structural connectivity','brain network','graph neural','gnn','network neuroscience','topology','hub','tractography'] },
    { id: 'DEEP_LEARNING', label: 'Deep Learning', words: ['deep learning','cnn','transformer','foundation model','llm','large language model','diffusion','spiking','snn','neuromorphic','attention','pretrain','pre-training','self-supervised','contrastive'] },
    { id: 'CLINICAL_APPS', label: 'Clinical Apps', words: ['clinical','rehabilitation','seizure','epilepsy','depression','alzheimer','stroke','therapy','emotion','attention','sleep','disorder','anxiety','patient','biomarker','diagnos'] },
    { id: 'SECURITY_PRIVACY', label: 'Security & Privacy', words: ['security','privacy','adversarial','federated','neurosecurity','threat','attack','privacy-preserving','synthetic data','encryption'] },
    { id: 'OTHER', label: 'Other', words: [] },
  ]

  function classifyTopic(keywords, text) {
    const t = (text || '').toLowerCase()
    const kws = (keywords || []).map(k => k.toLowerCase())
    let best = null
    let bestScore = 0
    for (const rule of TOPIC_RULES) {
      if (!rule.words.length) continue
      let score = 0
      for (const w of rule.words) {
        if (kws.includes(w)) score += 2
        else if (t.includes(w)) score += 1
      }
      if (score > bestScore) { bestScore = score; best = rule }
    }
    return best ? { id: best.id, label: best.label } : { id: 'OTHER', label: 'Other' }
  }

  const paperTopics = new Map()
  uniq.forEach(p => {
    paperTopics.set(p.id, classifyTopic(p.keywords, p.title + ' ' + p.abstract))
  })

  // Community assignment: curated topic (matches the expert-agent taxonomy:
  // BCI & EEG, Neural Decoding, Connectomics, Deep Learning, Clinical Apps,
  // Security & Privacy, Other). Robust at any corpus size, unlike connected
  // components which collapse to one giant cluster once the graph is dense.
  const topicFreq = {}
  uniq.forEach(p => {
    const t = paperTopics.get(p.id)
    topicFreq[t ? t.id : 'OTHER'] = (topicFreq[t ? t.id : 'OTHER'] || 0) + 1
  })
  const topicOrder = Object.entries(topicFreq)
    .sort((a, b) => b[1] - a[1])
    .map(x => x[0])
  const topicIndex = {}
  topicOrder.forEach((id, idx) => { topicIndex[id] = idx })
  const nodeComm = {}
  uniq.forEach(p => {
    const t = paperTopics.get(p.id)
    nodeComm[p.id] = topicIndex[t ? t.id : 'OTHER']
  })

  const jewel = ['#E0115F','#0F52BA','#50C878','#9966CC','#F4C430','#FF6B35','#40E0D0','#C71585','#20B2AA']

  let seed = 1
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280
    return seed / 233280
  }
  const gauss = () => {
    let u = 0, v = 0
    while(u === 0) u = rand()
    while(v === 0) v = rand()
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
  }

  const positions = {}
  const A = 180, B = 120, C = 80, MIN_D = 8
  const commCenters = {}
  const commList = [...new Set(Object.values(nodeComm))]
  commList.forEach((cid, idx) => {
    const ang = 2 * Math.PI * idx / commList.length
    commCenters[cid] = [A * 0.6 * Math.cos(ang), B * 0.6 * Math.sin(ang), C * 0.3 * Math.sin(2 * ang)]
  })

  uniq.forEach(p => {
    const cid = nodeComm[p.id]
    const c = commCenters[cid]
    let placed = false
    for (let attempt = 0; attempt < 400; attempt++) {
      const spread = 45
      const x = c[0] + gauss() * spread
      const y = c[1] + gauss() * spread
      const z = c[2] + gauss() * spread * 0.6
      if ((x/A)**2 + (y/B)**2 + (z/C)**2 > 1) continue
      let ok = true
      for (const [oid, op] of Object.entries(positions)) {
        const d = Math.sqrt((x-op[0])**2 + (y-op[1])**2 + (z-op[2])**2)
        if (d < MIN_D) { ok = false; break }
      }
      if (ok) {
        positions[p.id] = [Math.round(x*100)/100, Math.round(y*100)/100, Math.round(z*100)/100]
        placed = true
        break
      }
    }
    if (!placed) {
      const theta = rand() * Math.PI * 2
      const phi = Math.acos(2 * rand() - 1)
      const r = Math.cbrt(rand()) * 0.9
      positions[p.id] = [
        Math.round(A * r * Math.sin(phi) * Math.cos(theta) * 100) / 100,
        Math.round(B * r * Math.sin(phi) * Math.sin(theta) * 100) / 100,
        Math.round(C * r * Math.cos(phi) * 100) / 100
      ]
    }
  })

  const maxDeg = Math.max(...deg2.values()) || 1

  // Community labels = the curated topic label for each community id.
  const commLabels = {}
  topicOrder.forEach((id, idx) => {
    const rule = TOPIC_RULES.find(r => r.id === id)
    commLabels[idx] = rule ? rule.label : 'Other'
  })

  const nodes = uniq.map(p => {
    const t = paperTopics.get(p.id)
    const cid = nodeComm[p.id]
    return {
      id: p.id,
      title: p.title,
      authors: p.authors,
      first_author: getFirstAuthor(p.authors),
      abstract: p.abstract,
      year: parseInt(p.published.slice(0,4)) || 2024,
      url: p.url,
      published: p.published,
      keywords: p.keywords,
      topic: t ? t.id : 'OTHER',
      community: cid,
      community_label: commLabels[cid] || 'Other',
      color: jewel[cid % jewel.length],
      size: Math.round((3 + 9 * Math.sqrt((deg2.get(p.id) || 0) / maxDeg)) * 100) / 100 || 3,
      degree: deg2.get(p.id) || 0,
      fx: positions[p.id][0],
      fy: positions[p.id][1],
      fz: positions[p.id][2],
    }
  })

  const graph = {
    nodes,
    links: topEdges,
    meta: {
      total_papers: nodes.length,
      total_edges: topEdges.length,
      edge_type: 'keyword_cooccurrence',
      data_completeness: {
        citation_edges: 0,
        co_citation_edges: 0,
        keyword_cooccurrence_edges: topEdges.length,
        note: 'ArXiv API does not expose citation graphs. Edges derived from keyword co-occurrence (>=2 shared terms) as permitted fallback. All paper metadata is real and retrieved from arXiv.'
      },
      communities: commLabels,
      generated_at: new Date().toISOString().slice(0,10),
      source: 'arXiv API'
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(graph, null, 2))
  console.log(`Wrote ${nodes.length} nodes, ${topEdges.length} edges to ${OUT}`)
}

async function main() {
  const all = loadExistingPapers()
  if (all.length) console.log(`Seeding from existing corpus: ${all.length} papers`)
  for (const t of TOPICS) {
    console.log(`Fetching: ${t.q}`)
    try {
      const papers = await fetchArxiv(t.q, t.max)
      all.push(...papers)
      console.log(`  -> ${papers.length}`)
    } catch(e) {
      console.error(`  -> failed: ${e.message}`)
    }
    await new Promise(r => setTimeout(r, 3500))
  }
  buildGraph(all)
}

main()
