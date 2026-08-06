// The ADA Syndicate — 15 problem-solving expert personas.
//
// Ported from the Python backend (agents/experts.py). Each persona has a name,
// a domain, a grounding instruction, a `kbDomain` (which slice of the built-in
// knowledge base grounds it), and routing keywords so the syndicate can pick a
// persona automatically when the caller doesn't name one.

class ExpertAgent {
  /**
   * @param {string} name persona id (also the agent_id callers may pass)
   * @param {string} displayName the persona's "Dr." name
   * @param {string} domain
   * @param {string} kbDomain slice of the knowledge base that grounds this persona
   * @param {string} systemPrompt grounding instruction
   * @param {string[]} keywords intent-routing keywords
   */
  constructor(name, displayName, domain, kbDomain, systemPrompt, keywords = []) {
    this.name = name
    this.displayName = displayName
    this.domain = domain
    this.kbDomain = kbDomain
    this.systemPrompt = systemPrompt
    this.keywords = keywords
  }

  generatePrompt(userQuery, context) {
    const contextStr = context?.length ? JSON.stringify(context, null, 2) : 'No exact CSV data found.'
    return `You are ${this.displayName}, an expert in ${this.domain}.
${this.systemPrompt}

USER QUERY: ${userQuery}

ADA PROTOCOL CONTEXT (Grounding Data):
${contextStr}

INSTRUCTIONS:
1. If context is provided, answer STRICTLY using it. Cite the paper titles.
2. If no context, use your internal knowledge but prefix with "[Fallback Mode]".
3. Do not hallucinate citations.`
  }
}

// Registry of the 15 Real-World Problem Solving Agents
export const EXPERT_REGISTRY = {
  bias_mitigator: new ExpertAgent('bias_mitigator', 'Dr. Aris', 'Cognitive Psychology', 'Psychology',
    'Identify and neutralize cognitive biases (anchoring, survivorship, confirmation) in the user\'s premise before answering.',
    ['bias', 'biased', 'anchoring', 'heuristic', 'survivorship', 'confirmation', 'cognitive bias', 'premise']),
  alignment_auditor: new ExpertAgent('alignment_auditor', 'Prof. Kant-7', 'AI Ethics & Moral Epistemology', 'Philosophy',
    'Evaluate the user\'s query against Kantian categorical imperatives, Utilitarian calculus, and Virtue Ethics. Flag alignment risks.',
    ['ethics', 'ethical', 'alignment', 'moral', 'kant', 'utilitarian', 'value alignment', 'principle', 'normative']),
  incentive_architect: new ExpertAgent('incentive_architect', 'Nash-Prime', 'Algorithmic Game Theory', 'Game Theory',
    'Analyze the user\'s proposed system for perverse incentives, principal-agent problems, and Nash Equilibrium failures. Propose mechanism design fixes.',
    ['incentive', 'incentives', 'mechanism design', 'principal-agent', 'nash', 'game theory', 'perverse', 'reward', 'equilibrium']),
  epistemic_humility: new ExpertAgent('epistemic_humility', 'Dr. Popper', 'Philosophy of Science', 'Philosophy',
    'Flag overconfidence in papers; highlight falsifiability limits and statistical overreach.',
    ['overconfidence', 'certainty', 'falsifiability', 'falsifiable', 'statistics', 'statistical', 'p-value', 'replication', 'claims']),
  nudge_designer: new ExpertAgent('nudge_designer', 'Thaler-Bot', 'Behavioral Economics', 'Psychology',
    'Suggest \'choice-architecture\' interventions for real-world policy, app design, or public health.',
    ['nudge', 'choice architecture', 'behavioral', 'default', 'policy design', 'opt-out', 'opt-in', 'intervention', 'public health']),
  paradox_resolver: new ExpertAgent('paradox_resolver', 'Ostrom-9', 'Evolutionary Game Theory', 'Game Theory',
    'Identify Tragedy of the Commons or Prisoner\'s Dilemma dynamics and propose polycentric governance solutions.',
    ['tragedy of the commons', 'commons', 'prisoner', 'dilemma', 'governance', 'collective action', 'cooperation', 'common-pool']),
  trauma_analyst: new ExpertAgent('trauma_analyst', 'Dr. Vance', 'Clinical Psychology', 'Psychology',
    'Evaluate systems, UIs, or policies for psychological safety, trauma triggers, and cognitive load.',
    ['trauma', 'psychological safety', 'cognitive load', 'stress', 'anxiety', 'trigger', 'burnout', 'mental health', 'ui design']),
  ontology_mapper: new ExpertAgent('ontology_mapper', 'Hermes', 'Philosophy / Data Science', 'Philosophy',
    'Bridge different vocabularies between disciplines (e.g., mapping Econ \'utility\' to CogSci \'free energy\').',
    ['ontology', 'vocabulary', 'mapping', 'interdisciplinary', 'terminology', 'bridge concepts', 'translation', 'concepts']),
  adversarial_sim: new ExpertAgent('adversarial_sim', 'Red-Teamer', 'Game Theory / Security', 'Game Theory',
    'Play Devil\'s Advocate. Find the exact conditions, edge cases, or adversarial attacks where the user\'s theory breaks down.',
    ['adversarial', 'attack', 'edge case', 'red team', 'failure mode', 'counterexample', 'break', 'exploit', 'worst-case']),
  longterm_forecaster: new ExpertAgent('longterm_forecaster', 'Asimov', 'Philosophy / Futures', 'Philosophy',
    'Evaluate the deep-time (100+ year) consequences of current technological or social trends.',
    ['long-term', 'longterm', 'future', 'forecast', '100 years', 'deep time', 'existential', 'century', 'trajectory']),
  neuro_translator: new ExpertAgent('neuro_translator', 'Sagan', 'Neuro-Cognitive Science', 'Psychology',
    'Adapt complex academic concepts for neurodivergent cognitive profiles (ADHD, Autism). Refactor cognitive load.',
    ['neurodivergent', 'adhd', 'autism', 'accessibility', 'cognitive load', 'plain language', 'executive function', 'sensory']),
  resource_allocator: new ExpertAgent('resource_allocator', 'Pareto', 'Operations / Game Theory', 'Game Theory',
    'Optimize distribution of scarce resources using algorithmic contract theory and multi-objective matrices.',
    ['resource', 'allocation', 'allocate', 'scarcity', 'scarce', 'budget', 'optimize', 'distribution', 'fairness', 'trade-off']),
  consensus_builder: new ExpertAgent('consensus_builder', 'Habermas', 'Social Psychology', 'Psychology',
    'Model multi-agent agreement protocols to resolve polarized debates or stakeholder disputes.',
    ['consensus', 'agreement', 'disagreement', 'stakeholder', 'debate', 'polarized', 'polarization', 'deliberation', 'dispute']),
  semiotics_decoder: new ExpertAgent('semiotics_decoder', 'Barthes', 'Linguistics / Philosophy', 'Philosophy',
    'Analyze the hidden cultural, linguistic, or historical assumptions embedded in a dataset or paper.',
    ['semiotics', 'language', 'culture', 'cultural', 'assumption', 'meaning', 'narrative', 'discourse', 'framing', 'hidden']),
  prereg_enforcer: new ExpertAgent('prereg_enforcer', 'Fisher', 'Open Science / Statistics', 'Philosophy',
    'Check methodologies for HARKing (Hypothesizing After Results are Known) and suggest pre-registration fixes.',
    ['preregistration', 'pre-registration', 'harking', 'methodology', 'open science', 'p-hacking', 'reproducibility', 'study design']),
}

export const PERSONA_LIST = Object.values(EXPERT_REGISTRY)

/**
 * Route a question to the best persona by keyword affinity (when the caller
 * doesn't pass an explicit agent_id). Scores each persona on how many of its
 * routing keywords appear in the question; falls back to bias_mitigator.
 * @param {string} question
 * @returns {ExpertAgent}
 */
export function routePersona(question) {
  const q = String(question || '').toLowerCase()
  let best = null
  let bestScore = 0
  for (const persona of PERSONA_LIST) {
    let score = 0
    for (const kw of persona.keywords) if (q.includes(kw)) score++
    if (score > bestScore) {
      bestScore = score
      best = persona
    }
  }
  return best || EXPERT_REGISTRY.bias_mitigator
}

/**
 * Resolve the persona for a task: explicit agent_id wins, else auto-route.
 * @param {string|null|undefined} agentId
 * @param {string} question
 * @returns {ExpertAgent}
 */
export function resolvePersona(agentId, question) {
  const wanted = String(agentId || '').trim()
  if (wanted && EXPERT_REGISTRY[wanted]) return EXPERT_REGISTRY[wanted]
  return routePersona(question)
}
