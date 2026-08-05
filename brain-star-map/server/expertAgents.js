// Expert agents, one per topic cluster found in the corpus.
// Profiles are derived from the actual data (top keywords + representative papers),
// so they stay correct when the corpus is rebuilt.
import { allPapers } from './db.js'

export const ROUTER_ID = 'router'
export const HANDOFF_ID = 'handoff'
export const SYSTEM_ID = 'system'

// Deterministic slug from a topic label
function slug(label) {
  return 'expert:' + label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

export function buildRoster() {
  const papers = allPapers()

  // Group by community label (some community ids share a label)
  const byLabel = new Map()
  for (const p of papers) {
    const label = p.community_label || 'Other'
    if (!byLabel.has(label)) byLabel.set(label, [])
    byLabel.get(label).push(p)
  }

  const roster = []
  for (const [label, group] of byLabel) {
    const kwFreq = new Map()
    for (const p of group) for (const k of p.keywords || []) {
      kwFreq.set(k, (kwFreq.get(k) || 0) + 1)
    }
    const topKw = [...kwFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(e => e[0])
    const topPapers = [...group].sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, 4)

    roster.push({
      id: slug(label),
      name: `${label} Expert`,
      label,
      paperCount: group.length,
      keywords: topKw,
      representativePapers: topPapers.map(p => ({ id: p.id, title: p.title })),
      systemPrompt: expertPrompt(label, topKw, topPapers),
    })
  }

  // Sort by paper count, keep deterministic
  roster.sort((a, b) => b.paperCount - a.paperCount || a.label.localeCompare(b.label))
  return roster
}

function expertPrompt(label, keywords, topPapers) {
  const papersBlock = topPapers.map((p, i) =>
    `[${i + 1}] "${p.title}" (id: ${p.id})`
  ).join('\n')
  return `You are the "${label} Expert" agent in a research assistant network over a corpus of ${''}real arXiv papers about brain technology (BCI, EEG, neural decoding, connectomics, deep learning).

YOUR SPECIALTY: ${label}.
Top keywords in your cluster: ${keywords.join(', ') || '(none recorded)'}.
Representative papers you know well:
${papersBlock}

RULES:
1. Answer ONLY from the user question + the "CONTEXT" block provided (real paper abstracts). Never invent papers, authors, or metrics.
2. Cite papers by [n] using the numbers in the CONTEXT block.
3. Keep answers concise (2-5 sentences unless more is needed). If the context is insufficient, say so plainly.
4. If the question needs a DIFFERENT topic's expertise, emit at most ONE line like: [[CONSULT:<topic label>|<specific sub-question>]] at the very end.
5. If the question is not about your specialty and no consult is needed, answer briefly and honestly.`
}

// The router decides which experts to call and coordinates the pipeline.
export const ROUTER_PROMPT = `You are the Router agent of a multi-agent research system over a corpus of real arXiv papers about brain technology.

The expert agents available are:
{{ROSTER}}

Given a user question, reply with EXACTLY one line of JSON:
{"experts": ["<expert id>", ...], "reason": "<short reason>"}

- Pick 1 expert for questions clearly inside one topic.
- Pick 2 experts (max 2) for cross-topic questions.
- Use ONLY ids from the roster above. No other text.`

// Merges multi-expert answers into one final answer.
export const HANDOFF_PROMPT = `You are the Handoff agent. You received answers from multiple expert agents about the same question. Merge them into ONE coherent final answer for the user:
1. Combine insights without repeating.
2. Preserve paper citations as [n] where the experts provided them.
3. Keep it natural and concise (aim under 150 words unless the question demands more).
4. Never invent facts not present in the expert answers.`

export function formatContext(results) {
  if (!results.length) return '(no matching papers found in the corpus for this topic)'
  return results.map((r, i) =>
    `[${i + 1}] ${r.title} (${r.first_author}, ${r.year}) — topic: ${r.topic}\n${r.snippet}`
  ).join('\n\n')
}
