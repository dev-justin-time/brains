# Brain Citation Star Map

A pure-static, single-page 3D citation network for brain technology research.

## Quick Start

```bash
npm install
npm run build
# Deploy dist/ to *.kimi.page
```

The `public/graph_data.json` is already included (215 real papers from arXiv).
To regenerate from arXiv:
```bash
node scripts/build-data.js
```

## Data

- **215 real papers** from arXiv (BCI, EEG decoding, connectomics, neural security)
- **700 keyword co-occurrence edges** — arXiv API does not expose citations, so edges are derived from shared keywords (≥2 terms) as an honest fallback
- All metadata is real; no synthetic papers

## Stack

- React 18 + Vite
- react-force-graph-3d + Three.js
- UnrealBloomPass + custom stardust particles
- JSZip + file-saver for corpus export
- Node + node:sqlite + Ollama (expert-agent backend, `npm run serve`)

## Demo page

`public/demo.html` is a standalone, zero-build demo of the visualization (served
at `/demo.html`). It is a self-contained page that loads the same live
`public/graph_data.json` at runtime, so it always reflects the current data
without duplicating it. From the main app, click the **Demo page ↗** pill at the
top center, or open `demo.html` directly.

## Blocks Network agents

The expert-agent system is packaged as [Blocks Network](https://blocks.ai)
agents — one `agent-card.json` per expert topic plus a coordinating router,
built on the official `@blocks-network/sdk`.

```bash
npm run blocks:cards    # regenerate agent cards from the DB roster
npm run blocks:check    # validate all 7 cards with `blocks check`
npm run blocks:test     # offline handler contract test (router)
npm run blocks:test:expert
npm run blocks:registry # fetch the published agent's registry entry
npm run blocks:call -- router "<question>"   # call the live agent over the network
```

The **router agent is live on the Blocks Network** (public + free). Run
`npm run blocks:run` to keep it receiving tasks. See
[blocks/README.md](blocks/README.md) for the full setup, concepts, and the
exact register/publish procedure with real outputs.

## Features

- True 3D (no 2D fallback) with orbit/zoom/pan
- THREE.Sprite radial glow nodes colored by Louvain community (jewel tones)
- Gold edges at very low opacity (never form dense web)
- Camera entrance zoom + autoRotate
- Wheel captured with `{passive:false}` — page never scrolls
- Legend hover/click dims non-community nodes
- Click node → highlights neighbors + detail card with abstract + arXiv link
- Download Corpus button exports ZIP (CSV + README)
- ErrorBoundary + all hooks before early returns
- `data-completeness` badge honestly discloses edge methodology
