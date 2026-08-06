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
  description: 'Optional comma-separated specialist agentNames to call in parallel (default: auto-routes among ALL topic experts with affinity to the question, up to all six)',
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

// Premium multi-section agents (lit_review, grant_writer) generate long
// structured documents — give them double the standard budget (measured
// generations ~80-120s on this machine; leaves headroom on slower boxes).
const LONG_RUNTIME = {
  handler: HANDLER_PATH,
  handlerExport: 'default',
  concurrency: 1,
  expectedInstances: 1,
  maxRunningTimeSec: 600,
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

function card({ agentName, displayName, description, ioExtra, tags, runtime = RUNTIME }) {
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
    runtime,
  }
}

function orchestratorCard() {
  return card({
    agentName: 'orchestrator',
    displayName: 'Orchestrator — A2A Research Brief',
    description:
      'A2A orchestrator: auto-routes a question to every specialist expert agent with affinity to it (up to all six), calls them IN PARALLEL over the Blocks network (ctx.taskClient), and merges their cited answers into a single research brief.',
    runtime: LONG_RUNTIME, // 6-way fan-out: sub-tasks up to 240s each + merge
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
    runtime: LONG_RUNTIME,
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

// graph_explorer — LLM-free graph reasoning over the star-map (like the demo
// and sota_tracker: reads public/graph_data.json, no model calls, no stream).
function graphExplorerCard() {
  return {
    identity: {
      agentName: 'graph_explorer',
      displayName: 'Graph Explorer — Star-Map Reasoning',
      description:
        'Reasons directly over the citation star-map graph (215 papers, 700 keyword-co-occurrence edges): ' +
        'most central papers per topic, 1-hop subgraphs around a paper, community overview, bridge papers ' +
        '(betweenness), and shortest paths between papers. LLM-free — pure graph computation, instant and ' +
        'near-free. Returns a subgraph.json artifact when a subgraph or path is requested.',
      version: '1.0.0',
      provider: { organization: 'Brain Citation Star Map' },
    },
    capabilities: { taskKinds: ['request'] },
    io: {
      inputs: [{
        id: 'question',
        description: 'A graph question: "most central papers in Connectomics", "subgraph around <paper>", "shortest path between <A> and <B>", "bridge papers", "communities"',
        contentType: 'text/plain',
        required: true,
        example: 'Most central papers in Connectomics',
      }],
      outputs: [
        {
          id: 'answer',
          description: 'Graph answer (rankings, subgraphs, paths) computed from the star-map',
          contentType: 'text/plain',
          guaranteed: true,
          schema: { type: 'string' },
        },
        {
          id: 'subgraph',
          description: 'Requested subgraph / path as graph_data.json-shaped JSON (nodes + links), ready to visualize',
          contentType: 'application/json',
          guaranteed: false,
          schema: { type: 'object' },
        },
        {
          id: 'sources',
          description: 'Papers involved in the answer as structured JSON (title, year, arXiv URL)',
          contentType: 'application/json',
          guaranteed: false,
          schema: {
            type: 'array',
            items: { type: 'object', properties: { title: { type: 'string' }, year: { type: 'number' }, url: { type: 'string' } } },
          },
        },
      ],
    },
    // No streams block — LLM-free instant answers, same as star_map_demo / sota_tracker.
    tags: [
      ...COMMON_TAGS,
      {
        id: 'graph-explorer',
        name: 'Star-Map Graph Reasoning',
        description: 'Centrality, subgraphs, communities, bridges and paths over the visualization graph',
        examples: ['Most central papers in Connectomics', 'Shortest path between two papers'],
      },
    ],
    runtime: RUNTIME,
  }
}

// clinical_translator — LLM plain-language clinical practice notes (streams).
function clinicalTranslatorCard() {
  return card({
    agentName: 'clinical_translator',
    displayName: 'Clinical Translator — Plain-Language Practice Notes',
    description:
      'Turns research findings into plain-language clinical practice notes for stroke rehabilitation, cerebral ' +
      'palsy, neurofeedback, prosthetics and therapy applications. Four sections: PLAIN-LANGUAGE SUMMARY, ' +
      'WHAT THIS MEANS FOR CLINICIANS, KEY NUMBERS, CAVEATS & LIMITATIONS — with [n] citations. Written for ' +
      'clinicians and practitioners, not ML researchers.',
    tags: [
      {
        id: 'clinical-translation',
        name: 'Clinical Translation',
        description: 'Research findings -> actionable plain-language practice notes',
        examples: ['What does the latest EEG research mean for stroke rehabilitation?', 'Is neurofeedback ready for clinical use in children with cerebral palsy?'],
      },
    ],
  })
}

// grant_writer — LLM proposal draft (background + related work + citations).
function grantWriterCard() {
  return card({
    agentName: 'grant_writer',
    displayName: 'Grant Writer — Proposal Draft',
    runtime: LONG_RUNTIME,
    description:
      'Drafts the front matter of a research grant proposal from a research idea: TITLE, BACKGROUND, RELATED WORK ' +
      '(with [n] citations from the corpus via multi-hop retrieval), PROPOSED CONTRIBUTION, and RISKS & OPEN ' +
      'QUESTIONS. Returns a structured draft.json artifact. Premium-priced ($0.10) for the multi-hop research + ' +
      'synthesis work.',
    ioExtra: {
      inputs: [QUESTION_INPUT],
      outputs: [...OUTPUTS, {
        id: 'draft',
        description: 'Structured draft as JSON: idea, cited papers, and parsed sections (title + body per section)',
        contentType: 'application/json',
        guaranteed: false,
        schema: { type: 'object' },
      }],
    },
    tags: [
      {
        id: 'grant-writing',
        name: 'Grant Proposal Drafting',
        description: 'Research idea -> proposal background + related work with citations',
        examples: ['Draft a proposal on combining foundation models with Riemannian EEG decoding'],
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

// dataset_finder — datasets directory agent, LLM-free like sota_tracker
// (reads data/datasets.json, no model calls, no stream).
function datasetFinderCard() {
  return {
    identity: {
      agentName: 'dataset_finder',
      displayName: 'Dataset Finder — Dataset Directory',
      description:
        'Finds public datasets for brain-tech research: "which dataset for motor imagery?" or "details on BCI IV-2a". ' +
        'Answers from a directory seeded from the corpus abstracts (modality, task, subjects/classes, benchmark SOTA, ' +
        'and the corpus papers that use each dataset). LLM-free — pure retrieval from data/datasets.json, instant and near-free.',
      version: '1.0.0',
      provider: { organization: 'Brain Citation Star Map' },
    },
    capabilities: { taskKinds: ['request'] },
    io: {
      inputs: [{
        id: 'question',
        description: 'Which dataset for a task? Or a dataset name for its full card (e.g. "details on WAY-EEG-GAL", "dataset for seizure detection", "all datasets")',
        contentType: 'text/plain',
        required: true,
        example: 'Which dataset should I use for cross-subject motor imagery decoding?',
      }],
      outputs: [
        {
          id: 'answer',
          description: 'Ranked dataset cards (id, task, modality, subjects/classes, license, benchmark SOTA)',
          contentType: 'text/plain',
          guaranteed: true,
          schema: { type: 'string' },
        },
        {
          id: 'sources',
          description: 'Corpus papers that use/mention the datasets, as structured JSON (title, year, arXiv URL)',
          contentType: 'application/json',
          guaranteed: false,
          schema: { type: 'array' },
        },
      ],
    },
    // No streams block — LLM-free instant answers, same as star_map_demo / sota_tracker.
    tags: [
      ...COMMON_TAGS,
      {
        id: 'dataset-directory',
        name: 'Dataset Directory',
        description: 'Research question -> matching public datasets with metadata and benchmark SOTA',
        examples: ['Which dataset for motor imagery?', 'Details on BCI IV-2a'],
      },
    ],
    runtime: RUNTIME,
  }
}

// citation_hunter — LLM-free citation-style queries over the star-map graph
// (keyword-co-occurrence proxy, labeled honestly, same graph data as the demo).
function citationHunterCard() {
  return {
    identity: {
      agentName: 'citation_hunter',
      displayName: 'Citation Hunter — Who Cites Whom',
      description:
        'Answers citation-style questions over the star-map: "most cited papers in Connectomics", "who cites <paper>?", ' +
        '"how connected is <paper>?". LLM-free — pure graph computation, instant and near-free. Edges are the ' +
        'keyword-co-occurrence proxy (the star-map\u2019s citation graph is incomplete); every answer says so.',
      version: '1.0.0',
      provider: { organization: 'Brain Citation Star Map' },
    },
    capabilities: { taskKinds: ['request'] },
    io: {
      inputs: [{
        id: 'question',
        description: 'A citation-style question: "most cited papers in Connectomics", "who cites <paper title>?", "how many connections does <paper> have?"',
        contentType: 'text/plain',
        required: true,
        example: 'Who cites the DRDCAE-STGNN motor imagery paper?',
      }],
      outputs: [
        {
          id: 'answer',
          description: 'Citation-style answer from the star-map (proxy connections, honestly labeled)',
          contentType: 'text/plain',
          guaranteed: true,
          schema: { type: 'string' },
        },
        {
          id: 'sources',
          description: 'Related papers as structured JSON (title, year, arXiv URL)',
          contentType: 'application/json',
          guaranteed: false,
          schema: { type: 'array' },
        },
      ],
    },
    // No streams block — LLM-free instant answers.
    tags: [
      ...COMMON_TAGS,
      {
        id: 'citation-hunter',
        name: 'Citation-Style Queries',
        description: 'Most-cited / who-cites queries over the star-map proxy graph',
        examples: ['Most cited papers in Connectomics', 'Who cites a specific paper?'],
      },
    ],
    runtime: RUNTIME,
  }
}

// code_suggester — LLM PyTorch architecture skeleton (streams). Honesty
// guardrail: architecture outline only, never claims the code runs.
function codeSuggesterCard() {
  return card({
    agentName: 'code_suggester',
    displayName: 'Code Suggester — PyTorch Skeleton',
    description:
      'Turns a paper\u2019s method or a research idea into a PyTorch ARCHITECTURE SKELETON: ARCHITECTURE OVERVIEW, ' +
      'PYTORCH SKELETON (a model class + forward with the cited methods\u2019 design choices as comments), DATA & ' +
      'PREPROCESSING, TRAINING & EVALUATION, and LIMITATIONS — each citing the corpus papers it draws on. ' +
      'Returns a structured skeleton.json artifact. Skeletons are unverified starting points, not runnable code.',
    tags: [
      {
        id: 'code-suggestion',
        name: 'PyTorch Architecture Skeleton',
        description: 'Paper method -> compact PyTorch model skeleton with citations',
        examples: ['Sketch a CNN-LSTM architecture for motor imagery decoding', 'PyTorch skeleton for a Riemannian self-attention EEG decoder'],
      },
    ],
    ioExtra: {
      inputs: [QUESTION_INPUT],
      outputs: [...OUTPUTS, {
        id: 'skeleton',
        description: 'Structured skeleton as JSON: idea, cited papers, and parsed sections (title + body per section)',
        contentType: 'application/json',
        guaranteed: false,
        schema: { type: 'object' },
      }],
    },
  })
}

// paper_updates — live arXiv "what's new" pipe agent. Same pipe shape as
// paper_feed (dedicated "feed" events stream), but pulls from the live arXiv
// API instead of the static corpus.
function paperUpdatesCard() {
  return {
    identity: {
      agentName: 'paper_updates',
      displayName: 'Paper Updates — Live arXiv Stream',
      description:
        'Pipe-streaming agent: a live "what\u2019s new" feed from arXiv. Send a topic and a duration ' +
        '(1 minute – 30 days), and receive the NEWEST arXiv submissions on that topic as structured ' +
        'events (title, authors, published date, abstract snippet, category, arXiv URL) in real time, ' +
        'with fresh submissions picked up as the session runs. Evolves paper_feed (corpus stream) with a live source.',
      version: '1.0.0',
      provider: { organization: 'Brain Citation Star Map' },
    },
    capabilities: { taskKinds: ['pipe'] },
    io: {
      inputs: [{
        id: 'topic',
        description: 'A topic keyword or phrase for the live arXiv query (e.g. "motor imagery EEG", comma-separated terms are OR-ed)',
        contentType: 'text/plain',
        required: true,
        example: 'brain-computer interface, motor imagery',
      }],
      outputs: [{
        id: 'summary',
        description: 'Session summary as structured JSON (topic, streamed count, first/last published dates)',
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
        description: 'Live arXiv paper events: { type: "paper", id, title, authors, published, url, category, summary, source: "arxiv", at }',
      },
    },
    tags: [
      ...COMMON_TAGS,
      {
        id: 'live-arxiv-stream',
        name: 'Live arXiv Updates',
        description: 'Long-lived session streaming the newest arXiv submissions on a topic',
        examples: ['Stream new motor-imagery papers from arXiv'],
      },
    ],
    runtime: PIPE_RUNTIME,
  }
}

// ada_syndicate — the ADA Protocol engine as an agent: 15 reasoning personas
// (security sweep -> cache -> knowledge base -> persona synthesis). Streams.
function adaSyndicateCard() {
  return card({
    agentName: 'ada_syndicate',
    displayName: 'ADA Syndicate — 15 Reasoning Personas',
    description:
      'The ADA Protocol Autonomous Syndicate: routes your question to one of 15 reasoning personas ' +
      '(bias mitigation, ethics/alignment, incentive design, paradoxes, long-term forecasting, neurodivergent ' +
      'translation, preregistration, and more). Runs a security sweep, serves from a semantic cache, grounds ' +
      'the answer in the built-in knowledge base, then the persona synthesizes a cited reply. ' +
      'Pass an optional agent_id to pick a persona directly (e.g. "incentive_architect"); otherwise it auto-routes.',
    ioExtra: {
      inputs: [QUESTION_INPUT, {
        id: 'agent_id',
        description: 'Optional persona to route to: one of bias_mitigator, alignment_auditor, incentive_architect, epistemic_humility, nudge_designer, paradox_resolver, trauma_analyst, ontology_mapper, adversarial_sim, longterm_forecaster, neuro_translator, resource_allocator, consensus_builder, semiotics_decoder, prereg_enforcer (default: auto-route by intent)',
        contentType: 'text/plain',
        required: false,
        example: 'incentive_architect',
      }],
      outputs: [...OUTPUTS, {
        id: 'ada',
        description: 'ADA protocol metadata as structured JSON (status: BLOCKED / CACHE_HIT / LLM_GROUNDED / LLM_FALLBACK, persona, context_used, threats)',
        contentType: 'application/json',
        guaranteed: false,
        schema: { type: 'object' },
      }],
    },
    tags: [
      {
        id: 'ada-syndicate',
        name: 'ADA Protocol Syndicate',
        description: '15 reasoning personas grounded in a knowledge base, cached, security-swept',
        examples: ['incentive_architect: how do I stop perverse incentives in an LLM marketplace?', 'Analyze this policy for cognitive bias and alignment risks'],
      },
    ],
  })
}

// ada_fact_check — LLM-free DOI retraction / validity check.
function adaFactCheckCard() {
  return {
    identity: {
      agentName: 'ada_fact_check',
      displayName: 'ADA Fact Check — DOI Validity',
      description:
        'Checks a DOI (or a paper title from the ADA knowledge base) for retraction / validity status. ' +
        'LLM-free and instant. Heuristic check: flags known retracted DOIs and "retracted" markers; it is not ' +
        'an external registry lookup yet.',
      version: '1.0.0',
      provider: { organization: 'Brain Citation Star Map' },
    },
    capabilities: { taskKinds: ['request'] },
    io: {
      inputs: [{
        id: 'question',
        description: 'A DOI to check (e.g. "10.1103/PhysRevE.112") or a paper title from the ADA knowledge base',
        contentType: 'text/plain',
        required: true,
        example: '10.1103/PhysRevE.112',
      }],
      outputs: [
        {
          id: 'answer',
          description: 'Retraction / validity status of the DOI',
          contentType: 'text/plain',
          guaranteed: true,
          schema: { type: 'string' },
        },
        {
          id: 'sources',
          description: 'The matching knowledge-base paper, when found, as structured JSON',
          contentType: 'application/json',
          guaranteed: false,
          schema: { type: 'array' },
        },
      ],
    },
    // No streams block — LLM-free instant answers.
    tags: [
      ...COMMON_TAGS,
      {
        id: 'ada-fact-check',
        name: 'DOI Fact Check',
        description: 'Retraction / validity heuristic for DOIs and ADA knowledge-base papers',
        examples: ['Check 10.1103/PhysRevE.112', 'Is the Active Inference social coordination paper valid?'],
      },
    ],
    runtime: RUNTIME,
  }
}

// ada_harvest — the Paper Agent: live arXiv scrape (LLM-free).
function adaHarvestCard() {
  return {
    identity: {
      agentName: 'ada_harvest',
      displayName: 'ADA Harvest — arXiv Paper Agent',
      description:
        'The ADA Syndicate Paper Agent: scrapes arXiv for the NEWEST papers on a topic and returns them ' +
        'formatted for the star map (title, authors, year, abstract, URL). LLM-free, live arXiv API.',
      version: '1.0.0',
      provider: { organization: 'Brain Citation Star Map' },
    },
    capabilities: { taskKinds: ['request'] },
    io: {
      inputs: [{
        id: 'topic',
        description: 'A topic keyword or phrase for the arXiv search (e.g. "quantum game theory")',
        contentType: 'text/plain',
        required: true,
        example: 'mechanism design',
      }],
      outputs: [
        {
          id: 'answer',
          description: 'List of the newest harvested papers with links',
          contentType: 'text/plain',
          guaranteed: true,
          schema: { type: 'string' },
        },
        {
          id: 'sources',
          description: 'Harvested papers as structured JSON (id, title, authors, year, abstract, url)',
          contentType: 'application/json',
          guaranteed: false,
          schema: { type: 'array' },
        },
      ],
    },
    // No streams block — LLM-free instant answers.
    tags: [
      ...COMMON_TAGS,
      {
        id: 'ada-harvest',
        name: 'arXiv Paper Harvest',
        description: 'Live scrape of the newest arXiv papers on a topic, star-map formatted',
        examples: ['Harvest the newest papers on mechanism design', 'Get recent arXiv papers on AI ethics'],
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

  const cards = [
    starMapDemoCard(),
    sotaTrackerCard(),
    datasetFinderCard(),
    citationHunterCard(),
    graphExplorerCard(),
    litReviewCard(),
    clinicalTranslatorCard(),
    grantWriterCard(),
    codeSuggesterCard(),
    paperFeedCard(),
    paperUpdatesCard(),
    adaSyndicateCard(),
    adaFactCheckCard(),
    adaHarvestCard(),
    routerCard(),
    orchestratorCard(),
    ...roster.map(expertCard),
  ]
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
