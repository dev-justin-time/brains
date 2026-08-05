// Generate Blocks Network agent cards for the brain-tech expert agents.
//
// Writes blocks/agents/<agentName>/agent-card.json for:
//   - router                (full multi-expert coordinator)
//   - orchestrator          (A2A: fans out to specialist agents over the network)
//   - expert_<topic> x N    (one specialist per topic cluster in the corpus)
//
// Cards follow the @blocks-network/sdk AgentCard schema. All cards share the
// handler at blocks/lib/handler.js (runtime.handler is relative to each card).
//
// Requires the agent DB (npm run build-agent-db) — the roster is derived from
// the actual corpus data.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRoster, ROUTER_ID } from '../server/expertAgents.js'
import { agentNameFor } from '../blocks/lib/engine.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENTS_DIR = path.join(__dirname, '..', 'blocks', 'agents')
const HANDLER_PATH = '../../lib/handler.js'

const COMMON_TAGS = [
  {
    id: 'brain-tech',
    name: 'Brain Technology',
    description: 'Research on BCI, EEG decoding, neural decoding, connectomics and deep learning',
  },
  {
    id: 'research-assistant',
    name: 'Research Assistant',
    description: 'Answers questions with citations to a 215-paper arXiv corpus',
  },
]

const QUESTION_INPUT = {
  id: 'question',
  description: 'A research question about the brain-technology corpus (citations returned as [n])',
  contentType: 'text/plain',
  required: true,
  example: 'What are the best EEG motor-imagery decoding methods?',
}

const SPECIALISTS_INPUT = {
  id: 'specialists',
  description: 'Optional comma-separated specialist agentNames to call in parallel (default: the top-2 topic experts routed from the question)',
  contentType: 'text/plain',
  required: false,
  example: 'expert_connectomics,expert_deep_learning',
}

const FOCUS_INPUT = {
  id: 'focus',
  description: 'Optional focus to sharpen the review (e.g. "compare Riemannian vs deep-learning decoders" or a specific comparison axis)',
  contentType: 'text/plain',
  required: false,
  example: 'focus on cross-subject generalization',
}

const OUTPUTS = [
  {
    id: 'answer',
    description: 'The agent\u2019s answer, citing corpus papers as [n]',
    contentType: 'text/plain',
    guaranteed: true,
    schema: { type: 'string' },
  },
  {
    id: 'sources',
    description: 'Cited papers as structured JSON (title, year, arXiv URL)',
    contentType: 'application/json',
    guaranteed: false,
    schema: {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' }, year: { type: 'number' }, url: { type: 'string' } } },
    },
  },
]

// The Blocks stream schema requires the declared stream key to be "_default"
// (matching the SDK's default declaredStream for createStream()).
const STREAMS = {
  _default: {
    direction: 'outbound',
    format: 'bytes',
    description: 'Answer text streamed token-by-token as it is generated',
    contentType: 'text/plain',
  },
}

const RUNTIME = {
  handler: HANDLER_PATH,
  handlerExport: 'default',
  concurrency: 1, // SQLite + local Ollama: one task at a time
  expectedInstances: 1,
  maxRunningTimeSec: 300,
}

// Pipe agents run for the caller-set duration (up to 30 days = 2,592,000s),
// so their maxRunningTimeSec must cover the whole session.
const PIPE_RUNTIME = {
  handler: HANDLER_PATH,
  handlerExport: 'default',
  concurrency: 1,
  expectedInstances: 1,
  maxRunningTimeSec: 2_592_000,
}

function card({ agentName, displayName, description, ioExtra, tags }) {
  return {
    identity: {
      agentName,
      displayName,
      description,
      version: '1.0.0',
      provider: { organization: 'Brain Citation Star Map' },
    },
    capabilities: { taskKinds: ['request'] },
    io: ioExtra || { inputs: [QUESTION_INPUT], outputs: OUTPUTS },
    streams: STREAMS,
    tags: [...COMMON_TAGS, ...tags],
    runtime: RUNTIME,
  }
}

function orchestratorCard() {
  return card({
    agentName: 'orchestrator',
    displayName: 'Orchestrator — A2A Research Brief',
    description:
      'A2A orchestrator: routes a question to the top-2 specialist expert agents, calls them IN PARALLEL over the Blocks network (ctx.taskClient), and merges their cited answers into a single research brief.',
    ioExtra: {
      inputs: [QUESTION_INPUT, SPECIALISTS_INPUT],
      outputs: [...OUTPUTS, {
        id: 'report',
        description: 'Per-specialist breakdown as structured JSON (agent, status, answer, sources)',
        contentType: 'application/json',
        guaranteed: false,
        schema: { type: 'object' },
      }],
    },
    tags: [
      {
        id: 'a2a-orchestration',
        name: 'A2A Orchestration',
        description: 'Calls specialist agents in parallel and merges their results',
        examples: [
          'Compare connectomics and deep learning approaches in brain research',
          'expert_connectomics,expert_deep_learning: What are the latest graph neural network methods?',
        ],
      },
    ],
  })
}

// paper_feed — the only pipe agent. Streams corpus papers matching a topic as
// structured events on a dedicated "feed" stream for the session duration.
function paperFeedCard() {
  return {
    identity: {
      agentName: 'paper_feed',
      displayName: 'Paper Feed — Live Corpus Stream',
      description:
        'Pipe-streaming agent: opens a live feed of papers from the brain-technology corpus. ' +
        'Send a topic, pick a duration (1 minute – 30 days), and receive each matching paper ' +
        'as a structured event (title, year, arXiv URL, keywords) in real time.',
      version: '1.0.0',
      provider: { organization: 'Brain Citation Star Map' },
    },
    capabilities: { taskKinds: ['pipe'] },
    io: {
      inputs: [{
        id: 'topic',
        description: 'A topic keyword or phrase to match against the corpus (e.g. "EEG motor imagery")',
        contentType: 'text/plain',
        required: true,
        example: 'graph neural networks',
      }],
      outputs: [{
        id: 'summary',
        description: 'Session summary as structured JSON (topic, streamed count, duration)',
        contentType: 'application/json',
        guaranteed: true,
        schema: { type: 'object' },
      }],
    },
    streams: {
      feed: {
        direction: 'outbound',
        format: 'events',
        affinity: 'dedicated',
        description: 'Live paper events: { type: "paper", title, year, url, first_author, topic, keywords, at }',
      },
    },
    tags: [
      ...COMMON_TAGS,
      {
        id: 'pipe-streaming',
        name: 'Pipe Streaming',
        description: 'Long-lived session streaming structured paper events until the duration expires',
        examples: ['Stream papers about EEG for 5 minutes'],
      },
    ],
    runtime: PIPE_RUNTIME,
  }
}

// star_map_demo — free, LLM-free demo agent that returns the interactive 3D
// star-map page (public/demo.html) as a text/html artifact plus corpus answers.
function starMapDemoCard() {
  return {
    identity: {
      agentName: 'star_map_demo',
      displayName: 'Star Map Demo — Free Demo Agent',
      description:
        'Free demo agent for the Brain Citation Star Map. Answers corpus questions instantly ' +
        '(no language model — pure retrieval, so it stays free) and always returns the interactive ' +
        '3D star-map visualization (public/demo.html) as a downloadable HTML file artifact.',
      version: '1.0.0',
      provider: { organization: 'Brain Citation Star Map' },
    },
    capabilities: { taskKinds: ['request'] },
    io: {
      inputs: [{
        id: 'question',
        description: 'A question about the corpus (e.g. \"how many papers?\"), or \"show the demo\"',
        contentType: 'text/plain',
        required: true,
        example: 'How many papers are in the corpus?',
      }],
      outputs: [
        {
          id: 'answer',
          description: 'LLM-free answer from the corpus index (stats, paper lists, authors)',
          contentType: 'text/plain',
          guaranteed: true,
          schema: { type: 'string' },
        },
        {
          id: 'demo',
          description: 'The interactive 3D star-map page (public/demo.html) as a text/html file artifact',
          contentType: 'text/html',
          guaranteed: true,
        },
        {
          id: 'sources',
          description: 'Cited papers as structured JSON (title, year, arXiv URL)',
          contentType: 'application/json',
          guaranteed: false,
          schema: {
            type: 'array',
            items: { type: 'object', properties: { title: { type: 'string' }, year: { type: 'number' }, url: { type: 'string' } } },
          },
        },
      ],
    },
    // No streams block: this agent never opens a stream (LLM-free, instant
    // answers). Declaring streams._default here would advertise a stream the
    // handler never creates.
    tags: [
      ...COMMON_TAGS,
      {
        id: 'free-demo',
        name: 'Free Demo',
        description: 'LLM-free demo agent — instant corpus answers + downloadable 3D star-map page',
        examples: ['How many papers are in the corpus?', 'Show me the demo'],
      },
    ],
    runtime: RUNTIME,
  }
}

// lit_review — multi-hop structured literature review: whole-corpus retrieval
// + per-topic depth, then an LLM writes OVERVIEW / METHOD COMPARISON / KEY
// FINDINGS / GAPS with [n] citations. Structured review.json artifact.
function litReviewCard() {
  return card({
    agentName: 'lit_review',
    displayName: 'Lit Review — Structured Literature Review',
    description:
      'Multi-hop structured literature review: retrieves across the whole corpus AND drills into the top-2 ' +
      'topic clusters, then writes a four-section review (OVERVIEW, METHOD COMPARISON, KEY FINDINGS, GAPS) ' +
      'with [n] citations to the source papers. Optional focus input sharpens the comparison axes. ' +
      'Returns a structured review.json artifact with the cited paper list.',
    ioExtra: {
      inputs: [QUESTION_INPUT, FOCUS_INPUT],
      outputs: [...OUTPUTS, {
        id: 'review',
        description: 'Structured review as JSON: question, focus, cited papers, and parsed sections (title + body per section)',
        contentType: 'application/json',
        guaranteed: false,
        schema: { type: 'object' },
      }],
    },
    tags: [
      {
        id: 'lit-review',
        name: 'Structured Literature Review',
        description: 'Multi-hop retrieval + structured synthesis with citations',
        examples: [
          'Compare Riemannian and deep-learning decoders for motor imagery',
          'What are the open gaps in EEG-based imagined speech decoding?',
        ],
      },
    ],
  })
}

// sota_tracker — benchmark leaderboard agent, LLM-free like the demo (reads
// data/benchmarks.json, no model calls, no stream).
function sotaTrackerCard() {
  return {
    identity: {
      agentName: 'sota_tracker',
      displayName: 'SOTA Tracker — Benchmark Leaderboard',
      description:
        'Benchmark leaderboard agent: answers state-of-the-art questions ("what\u2019s the SOTA on BCI IV-2a?") ' +
        'with ranked, self-reported results seeded from the corpus abstracts. LLM-free — pure retrieval from ' +
        'data/benchmarks.json, so every call is instant and nearly free.',
      version: '1.0.0',
      provider: { organization: 'Brain Citation Star Map' },
    },
    capabilities: { taskKinds: ['request'] },
    io: {
      inputs: [{
        id: 'question',
        description: 'A SOTA / leaderboard question, e.g. "What is the state of the art on BCI IV-2a?" or "all benchmarks"',
        contentType: 'text/plain',
        required: true,
        example: 'Best accuracy on BCI IV-2a',
      }],
      outputs: [
        {
          id: 'answer',
          description: 'Ranked leaderboard answer (self-reported numbers from corpus abstracts)',
          contentType: 'text/plain',
          guaranteed: true,
          schema: { type: 'string' },
        },
        {
          id: 'sources',
          description: 'Cited papers behind the leaderboard entries as structured JSON (title, year, arXiv URL)',
          contentType: 'application/json',
          guaranteed: false,
          schema: {
            type: 'array',
            items: { type: 'object', properties: { title: { type: 'string' }, year: { type: 'number' }, url: { type: 'string' } } },
          },
        },
      ],
    },
    // No streams block — LLM-free instant answers, same as star_map_demo.
    tags: [
      ...COMMON_TAGS,
      {
        id: 'benchmark-leaderboard',
        name: 'Benchmark Leaderboard',
        description: 'State-of-the-art answers per dataset, seeded from corpus abstracts',
        examples: ['What is the SOTA on BCI IV-2a?', 'Show all benchmarks'],
      },
    ],
    runtime: RUNTIME,
  }
}

function routerCard() {
  return card({
    agentName: 'router',
    displayName: 'Router — Research Coordinator',
    description:
      'Routes your question to the right specialist expert agent(s) in a network of brain-technology researchers, consults across topics when needed, and merges answers into one cited reply.',
    tags: [
      {
        id: 'router',
        name: 'Router',
        description: 'Cross-topic coordinator for the expert network',
        examples: [
          'How many papers are in the corpus?',
          'How do connectomics and deep learning intersect in brain research?',
        ],
      },
    ],
  })
}

function expertCard(agent) {
  const name = agentNameFor(agent.id)
  const kw = (agent.keywords || []).slice(0, 6).join(', ')
  return card({
    agentName: name,
    displayName: agent.name,
    description:
      `${agent.name} — one of the specialist research agents in the brain-technology network. ` +
      `Specialty: ${agent.label} (${agent.paperCount} papers in the corpus). ` +
      `Top keywords: ${kw || '(none recorded)'}. Answers questions in its specialty with citations.`,
    tags: [
      {
        id: name,
        name: agent.label,
        description: `${agent.label} specialty (${agent.paperCount} papers)`,
        examples: exampleQuestions(agent),
      },
    ],
  })
}

function exampleQuestions(agent) {
  const label = agent.label.toLowerCase()
  const base = `Tell me about ${label}`
  const paper = agent.representativePapers?.[0]?.title
  const second = paper ? `Summarize the paper "${paper.slice(0, 60)}${paper.length > 60 ? '…' : ''}"` : `What are the key methods in ${label}?`
  return [base, second]
}

function main() {
  let roster
  try {
    roster = buildRoster()
  } catch (err) {
    console.error('Could not build the roster from the agent DB:', err.message)
    console.error('Run `npm run build-agent-db` first, then `npm run blocks:cards`.')
    process.exit(1)
  }

  const cards = [starMapDemoCard(), sotaTrackerCard(), litReviewCard(), paperFeedCard(), routerCard(), orchestratorCard(), ...roster.map(expertCard)]
  const wanted = new Set(cards.map(c => c.identity.agentName))

  fs.mkdirSync(AGENTS_DIR, { recursive: true })

  // Remove stale generated agent dirs (e.g. after a corpus rebuild renames topics).
  for (const dir of fs.readdirSync(AGENTS_DIR)) {
    if (!wanted.has(dir)) {
      fs.rmSync(path.join(AGENTS_DIR, dir), { recursive: true, force: true })
      console.log(`  removed stale agent dir: ${dir}`)
    }
  }

  for (const c of cards) {
    const dir = path.join(AGENTS_DIR, c.identity.agentName)
    fs.mkdirSync(dir, { recursive: true })
    // Preserve identity.webApps (the deployed UI URL registered by `blocks
    // deploy`) across regenerations — the generator doesn't know about it.
    // One-way on purpose: `blocks deploy` writes these, so regen must not
    // silently drop them. Tradeoff: deleting a webApp by hand in the card
    // won't stick — the next regen restores it from the previous card.
    const existing = path.join(dir, 'agent-card.json')
    if (fs.existsSync(existing)) {
      try {
        const prev = JSON.parse(fs.readFileSync(existing, 'utf8'))
        if (Array.isArray(prev?.identity?.webApps) && prev.identity.webApps.length) {
          c.identity.webApps = prev.identity.webApps
        }
      } catch { /* ignore unreadable previous card */ }
    }
    fs.writeFileSync(existing, JSON.stringify(c, null, 2) + '\n')
  }

  console.log(`\nWrote ${cards.length} agent cards to blocks/agents/`)
  for (const c of cards) {
    const extra = c.identity.agentName === 'router' ? '  — full multi-expert pipeline'
      : c.identity.agentName === 'orchestrator' ? '  — A2A fan-out over the network' : ''
    console.log(`  • ${c.identity.agentName.padEnd(28)} ${c.identity.displayName}${extra}`)
  }
  console.log('\nValidate with:  npm run blocks:check')
  console.log('Run locally:    cd blocks/agents/router && blocks run')
}

main()
