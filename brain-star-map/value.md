# value.md — Growing the Brain Citation Star Map

> Strategic suggestions for new **agents**, **data**, and **features** to attract
> users to the Blocks Network deployment. Grounded in what already exists; each
> item notes effort/impact so you can pick the next move.

---

## 1. Where we are (assets to build on)

| Asset | Detail |
|---|---|
| Corpus | 215 arXiv papers, 700 keyword-co-occurrence links, 6 communities (Neural Decoding, BCI & EEG, Deep Learning, Connectomics, Clinical Apps, Other) |
| Live agents (9) | `router`, `orchestrator`, `expert_connectomics`, `expert_bci_eeg`, `paper_feed` (pipe, $0.02/min), `star_map_demo` (free), A2A trio `my_echo`/`my_adder`/`my_orchestrator` |
| Dormant cards (4) | `expert_clinical_apps`, `expert_deep_learning`, `expert_neural_decoding`, `expert_other` — generated, never published |
| Engine | `server/` hybrid retrieval + local Ollama → **near-zero marginal cost**, LLM-free fast paths |
| Front doors | Web console **https://ui-c7w.pages.dev**, public GitHub repo, 8 paid agents @ $0.02/task (85/15 split) |

The unit economics are already good (≈100% margin). Growth = more users, and
users come from **capability breadth** (more agents/data) and **discovery**
(free funnel + shareable output).

---

## 2. New agents (ranked by impact ÷ effort)

### P0 — cheap, reuses existing infrastructure
1. **Activate the 4 dormant cards** — `expert_deep_learning`, `expert_neural_decoding`,
   `expert_clinical_apps`, `expert_other`. The cards and shared handler already
   exist; publish + run them. Instantly widens the catalog from 2 topic experts to 6.
   - *Pricing:* $0.02/task, 3 free trials. *Effort: hours.*
2. **`lit_review`** (request) — "compare Riemannian vs deep-learning decoders for
   motor imagery" → structured literature review with cited papers, method table,
   and gaps. Built on existing retrieval; the orchestrator can call it.
   - *Why:* the #1 task researchers actually have. *Price: $0.10/task* (multi-hop).
3. **`sota_tracker`** (request) — per-task leaderboard agent: "best accuracy on
   BCI-IV 2a?" → dataset/task → best reported metric + paper. Feeds `dataset_finder`.
   - *Why:* benchmark numbers are what researchers search for constantly.

### P1 — new data unlocks these
4. **`dataset_finder`** — research question → matching public datasets
   (BCI-IV 2a/2b, PhysioNet MI, WAY-EEG-GAL, MOABB, OpenBMI) with modality,
   channels, classes, licenses, and reported SOTA. *Needs:* datasets table.
5. **`citation_hunter`** — "who cites X / what does X build on?" citation-neighbor
   queries. *Needs:* real citation edges (currently only keyword proxy).
6. **`paper_updates`** (pipe, evolves `paper_feed`) — subscribe to a topic;
   stream new papers daily. *Needs:* scheduled arXiv refresh + per-user digests.
   - *Why:* pipe revenue is recurring ($0.02/min ≈ subscription-like).
7. **`code_suggester`** — turn a paper's method into a PyTorch skeleton.
   *Needs:* code links + method text. Risky (hallucination) → keep to architecture
   outlines, cite the paper.

### P2 — differentiators (marketing magnets)
8. **`graph_explorer`** — the star-map as an agent: "most central papers in
   connectomics?" → subgraph + centrality answers. *Why:* the visualization is
   our unique asset; an agent that *reasons over the graph* is novel on Blocks.
9. **`clinical_translator`** — paper findings → plain-language clinical practice
   notes (stroke rehab, CP, neurofeedback). Unlocks non-researcher users.
10. **`grant_writer`** — research-idea → draft proposal background + related work
    with citations. *Needs:* funding/grant text corpus.

---

## 3. New data (what attracts users)

| Data | Feeds | Source |
|---|---|---|
| **Real citation graph** (replaces keyword proxy) | `citation_hunter`, `graph_explorer`, centrality rankings | arXiv citation API / Semantic Scholar |
| **Full-text/PDFs** (arXiv open access) | true RAG answers, `lit_review` depth | arXiv bulk download |
| **Code links + SOTA numbers** | `code_suggester`, `sota_tracker` | Papers-with-Code / GitHub |
| **Benchmark leaderboard** (MOABB, BCI-IV, PhysioNet) | `sota_tracker`, `dataset_finder` | curated table (highest-value new asset) |
| **Datasets directory** (modality, channels, license) | `dataset_finder` | curated + community |
| **Author/lab graph** | "who works on X" answers | arXiv metadata |
| **Expanded categories** (fMRI, fNIRS, ECoG, neuroimaging) | all agents get broader | arXiv API |
| **Clinical trial data** (ChiCTR / ClinicalTrials.gov) | `clinical_translator` | public registries |

*Note:* several papers in the corpus already cite benchmark datasets — a
`benchmarks` table can be seeded from the corpus itself (zero new scraping).

---

## 4. Features (front door → paying users)

1. **Free → paid funnel in the UI**: `star_map_demo` is free and anonymous;
   the console should upsell mid-session ("want cited sources? try Router") —
   today the 3 free trials/org do this, but surface them visibly.
2. **Topic subscriptions**: paper_feed daily digest delivered to email/webhook
   (recurring pipe revenue + retention hook).
3. **Shareable research briefs**: one-click public URL of a `lit_review` result —
   free viral loop (each brief advertises the platform).
4. **Export actions**: BibTeX / CSV / citation-graph JSON downloads (researchers
   live in reference managers).
5. **Paper cards upgrade**: code link, dataset badge, SOTA badge, "cited by" —
   turn the star-map into a research hub.
6. **Compare mode**: ask two agents the same question, diff answers side-by-side.
7. **A2A showcase button**: "deep-dive" → orchestrator fans out to 3 experts and
   composes a report — demonstrates the network's signature capability.

---

## 5. Growth playbook (how users find us)

- **Content from our own data**: publish "BCI benchmark landscape" / "most-cited
  motor-imagery methods" as blog posts + the `sota_tracker` numbers — we are the
  only agent with this corpus.
- **GitHub repo is a channel**: README → web console → agents.
- **A2A hub positioning**: be the knowledge layer other builders' agents call;
  every external orchestrator that routes to `router` adds volume.
- **Catalog listing quality**: each agent card already has tags/descriptions/
  examples — keep them sharp; free `star_map_demo` is the anonymous try-me card.
- **Price later, traffic first**: keep $0.02 while adoption is thin; raise
  `orchestrator`/`lit_review` (multi-hop work) to $0.05–0.10 once there are users.

---

## 6. Prioritized roadmap

| # | Move | Effort | Impact | Revenue type |
|---|---|---|---|---|
| 1 | Publish 4 dormant expert cards | ✅ done 2026-08-05 | — | per-task |
| 2 | `lit_review` agent | 1–2 days | High | per-task (priced higher) |
| 3 | Benchmark leaderboard data + `sota_tracker` | 2–3 days | High | per-task |
| 4 | Topic subscriptions on `paper_feed` | 1–2 days | High | recurring (pipe) |
| 5 | Real citation graph | 2–4 days | Medium-High | unlocks 2 agents |
| 6 | Shareable briefs + exports in UI | 1–2 days | Medium | acquisition |
| 7 | `graph_explorer`, `clinical_translator` | 3–5 days | Medium | differentiation |

**Do 2–3 next**: they reuse the existing engine, widen the catalog, and give the
web console a "benchmark answers" feature nobody else has.

---

## 7. Metrics worth tracking (dashboard + Stripe)

- Paid tasks/day per agent (conversion from 3-free-trial allowance)
- Anonymous → sign-in conversion on `star_map_demo` / console
- `paper_feed` session minutes (recurring revenue proxy)
- Shareable-brief clicks (viral loop)
- Catalog listing views → task starts (discoverability)

*Track these in the blocks dashboard + Stripe; a future `scripts/agent-usage-stats.mjs`
can pull counts automatically if the platform exposes the `listTasks` RPC.*
