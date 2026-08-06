# value.md — Growing the Brain Citation Star Map

> Strategic suggestions for new **agents**, **data**, and **features** to attract
> users to the Blocks Network deployment. Grounded in what already exists; each
> item notes effort/impact so you can pick the next move.

---

## 1. Where we are (assets to build on)

| Asset | Detail |
|---|---|
| Corpus | 215 arXiv papers, 700 keyword-co-occurrence links, 6 communities (Neural Decoding, BCI & EEG, Deep Learning, Connectomics, Clinical Apps, Other) |
| Live agents (22) | `router`, `orchestrator`, six experts, `paper_feed` + `paper_updates` (pipe, $0.02/min), `star_map_demo` (free), `sota_tracker`, `dataset_finder`, `citation_hunter`, `lit_review` ($0.10), `graph_explorer`, `clinical_translator`, `code_suggester`, `grant_writer` ($0.10), A2A trio `my_echo`/`my_adder`/`my_orchestrator` |
| Dormant cards (4) | ✅ **published + live 2026-08-05** — `expert_clinical_apps`, `expert_deep_learning`, `expert_neural_decoding`, `expert_other` |
| Engine | `server/` hybrid retrieval + local Ollama → **near-zero marginal cost**, LLM-free fast paths |
| Front doors | Web console **https://ui-c7w.pages.dev**, public GitHub repo, 21 paid agents (17 @ $0.02/task, `lit_review` + `grant_writer` @ $0.10/task, 2 pipe @ $0.02/min) + 1 free (`star_map_demo`) (85/15 split); all 22 agents supervised with boot auto-start (see Operations) |
| Operations | ✅ **all 22 agents supervised + auto-start 2026-08-05** — `scripts/supervise-all-agents.js` (`npm run blocks:watch:all`) runs one watchdog per agent (crash-restart with exponential backoff, PID-locked, per-agent logs) and the whole network boots at logon via the Windows Startup folder entry (`BlocksAgentNetwork.cmd`). Task Scheduler is admin-gated on this box, so Startup folder is the mechanism. |

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
2. **`lit_review`** (request) — ✅ **done 2026-08-05**: multi-hop structured
   review agent (whole-corpus + top-2 topic retrieval → OVERVIEW / METHOD
   COMPARISON / KEY FINDINGS / GAPS with [n] citations + structured
   review.json). Published **public + paid $0.10/task**, live + verified over
   the network. The orchestrator can call it.
3. **`sota_tracker`** (request) — ✅ **done 2026-08-05**: benchmark leaderboard
   agent seeded from the corpus (`data/benchmarks.json`, 12 datasets), published
   public + paid $0.02, live + verified. "Best accuracy on BCI-IV 2a?" → ranked
   self-reported metric + paper (LLM-free, zero model cost). Feeds `dataset_finder`.

### P1 — new data unlocks these
4. **`dataset_finder`** — ✅ **done 2026-08-05**: LLM-free "which dataset for
   X?" agent served from `data/datasets.json` (17 datasets seeded from the
   corpus: task, modality, subjects/classes, license status, benchmark SOTA,
   corpus users). Live @ $0.02.
5. **`citation_hunter`** — ✅ **done 2026-08-05**: LLM-free "who cites X / what
   does X build on?" over the star-map. Edges are still the keyword-proxy
   (honest label on every answer); the real-citation fetch from Semantic
   Scholar was rate-limited (429 without a key), so proxy stands until a key
   is available.
6. **`paper_updates`** (pipe, evolves `paper_feed`) — ✅ **done 2026-08-05**: live
   arXiv "what's new" pipe — queries the real arXiv API (newest-first, paging +
   wrap-around), streams new papers as `feed` events, live @ $0.02/min.
   *Next:* per-user digests (email/webhook) for true recurring subscriptions.
7. **`code_suggester`** — ✅ **done 2026-08-05**: paper method/idea → PyTorch
   ARCHITECTURE SKELETON (model class + forward) with [n] citations via
   multi-hop retrieval. Hallucination-guarded: unverified outline only, no
   fabricated APIs. Live @ $0.02.

### P2 — differentiators (marketing magnets)
8. **`graph_explorer`** — ✅ **done 2026-08-05**: the star-map as an agent.
   LLM-free graph reasoning over `public/graph_data.json` — centrality per
   topic, 1-hop subgraphs (+ `subgraph.json` artifact), communities, bridges
   (betweenness), shortest paths. Live @ $0.02.
9. **`clinical_translator`** — ✅ **done 2026-08-05**: paper findings →
   plain-language clinical practice notes (stroke rehab, CP, neurofeedback),
   clinical-keyword-ranked retrieval + LLM synthesis. Live @ $0.02.
10. **`grant_writer`** — ✅ **done 2026-08-05**: research idea → proposal draft
    (TITLE / BACKGROUND / RELATED WORK / PROPOSED CONTRIBUTION / RISKS) with
    citations via lit_review's multi-hop retrieval. Live @ $0.10. *(The
    roadmap's funding/grant text corpus is not bundled — drafts are generated
    from the real papers corpus, the honest scope.)*

---

## 3. New data (what attracts users)

| Data | Feeds | Source | Status |
|---|---|---|---|
| **Real citation graph** (replaces keyword proxy) | `citation_hunter`, `graph_explorer`, centrality rankings | arXiv citation API / Semantic Scholar | ⏳ Semantic Scholar unauthenticated API rate-limited (429) — needs an API key; proxy stands meanwhile |
| **Full-text/PDFs** (arXiv open access) | true RAG answers, `lit_review` depth | arXiv bulk download | open |
| **Code links + SOTA numbers** | `code_suggester`, `sota_tracker` | Papers-with-Code / GitHub | open |
| **Benchmark leaderboard** (MOABB, BCI-IV, PhysioNet) | `sota_tracker`, `dataset_finder` | curated table (highest-value new asset) | ✅ `data/benchmarks.json` — 12 datasets seeded |
| **Datasets directory** (modality, channels, license) | `dataset_finder` | curated + community | ✅ `data/datasets.json` — 17 datasets seeded; licenses need curation |
| **Live arXiv feed** | `paper_updates` (pipe) | arXiv API (works, verified live) | ✅ |
| **Author/lab graph** | "who works on X" answers | arXiv metadata | open |
| **Expanded categories** (fMRI, fNIRS, ECoG, neuroimaging) | all agents get broader | arXiv API | open |
| **Clinical trial data** (ChiCTR / ClinicalTrials.gov) | `clinical_translator` | public registries | open |

*Note:* several papers in the corpus already cite benchmark datasets — a
`benchmarks` table can be seeded from the corpus itself (zero new scraping).

---

## 4. Features (front door → paying users)

1. **Free → paid funnel in the UI** — ✅ **done 2026-08-05**: "Try the free demo
   first — no funds needed" on the sign-in gate lands users in `star_map_demo`;
   gate shows the $0.02–$0.10 pricing + 3-free-trials note.
2. **Topic subscriptions** — 🟡 **half done**: `paper_updates` (live arXiv pipe)
   is the stream; a per-user digest delivery (email/webhook) is still open
   (recurring pipe revenue + retention hook).
3. **Shareable research briefs** — 🟡 **half done**: "Copy brief" exports the
   answer + sources as Markdown; a public URL shortlink needs a small server
   (free viral loop).
4. **Export actions** — ✅ **done 2026-08-05**: BibTeX + CSV downloads of the
   sources and Copy-brief (Markdown) in the console.
5. **Paper cards upgrade**: code link, dataset badge, SOTA badge, "cited by" —
   open (needs code links / citation data).
6. **Compare mode**: ask two agents the same question, diff answers side-by-side
   — open.
7. **A2A showcase button** — ✅ **done 2026-08-05**: one-click "A2A deep-dive"
   card fans a question out to the orchestrator (all relevant experts).

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
| 2 | `lit_review` agent | ✅ done 2026-08-05 | — | per-task ($0.10) |
| 3 | Benchmark leaderboard data + `sota_tracker` | ✅ done 2026-08-05 | — | per-task |
| 4 | Topic subscriptions on `paper_feed` | ✅ done 2026-08-05 (`paper_updates` live arXiv pipe; per-user digests still open) | High | recurring (pipe) |
| 5 | Real citation graph | ✅ done 2026-08-05 (`citation_hunter` on the honest proxy; real edges blocked on a Semantic Scholar key) | Medium-High | unlocks 2 agents |
| 6 | Shareable briefs + exports in UI | ✅ done 2026-08-05 (exports + copy-brief; public URL shortlinks open) | Medium | acquisition |
| 7 | `graph_explorer`, `clinical_translator` | ✅ done 2026-08-05 | — | differentiation |
| 8 | `grant_writer` | ✅ done 2026-08-05 | — | per-task ($0.10) |
| 9 | `dataset_finder` + `code_suggester` | ✅ done 2026-08-05 | — | per-task |
| 10 | `citation_hunter` | ✅ done 2026-08-05 | — | per-task |
| 11 | `paper_updates` live arXiv pipe | ✅ done 2026-08-05 | — | recurring (pipe) |

**All P0 + P1 + P2 items done (2026-08-05).** The full remaining roadmap is:
- **Per-user topic digests** on `paper_updates` (email/webhook) — the recurring
  subscription product.
- **Real citation edges** once a Semantic Scholar API key is available
  (`scripts/fetch-citations.mjs` placeholder note in value.md; the proxy
  `citation_hunter` is live meanwhile).
- **Shareable brief URLs** (tiny server or shortlink) for the viral loop.
- **Console:** compare mode + paper cards upgrade (dataset/SOTA/code badges).
- **Catalog breadth**: expanded categories (fMRI/fNIRS/ECoG) via arXiv fetch.

---

## 7. Metrics worth tracking (dashboard + Stripe)

- Paid tasks/day per agent (conversion from 3-free-trial allowance)
- Anonymous → sign-in conversion on `star_map_demo` / console
- `paper_feed` session minutes (recurring revenue proxy)
- Shareable-brief clicks (viral loop)
- Catalog listing views → task starts (discoverability)

*Track these in the blocks dashboard + Stripe; a future `scripts/agent-usage-stats.mjs`
can pull counts automatically if the platform exposes the `listTasks` RPC.*
