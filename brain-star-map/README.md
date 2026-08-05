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
