# Brain Star Map — Research Console (`ui/`)

A deployable web UI for the Blocks Network agents, scaffolded with
`blocks init --mode webapp` for all 9 published agents and customized into a
star-map themed research console.

```
ui/
├── blocks.config.json     # template version, agents list, backendBaseUrl
├── README.md
└── web/                   # the static site (uploaded by `blocks deploy`)
    ├── index.html         # page shell + Blocks embed-auth widget loader
    ├── app.js             # auth plumbing (verbatim scaffold) + data-driven agent wiring
    └── styles.css         # dark-space theme (starfield, glassmorphism, agent colors)
```

## What the UI does

- **Sign in with Blocks** — popup OAuth via the embed-auth widget; one session
  covers all 7 agents (`signInAndGetClients`). JWT (~60s, in-memory) +
  refresh token (24h, partitioned localStorage), auto-refresh before expiry,
  and silent auto-resume on reload when the stored partition matches.
- **Agent switcher** — chips for each agent; the console shows the agent's
  card inputs and tagline, and renders its artifacts:
  - `answer` → streamed text with `[n]` citation markers styled
  - `sources` → clickable arXiv citation cards (`[{ title, year, url }]`)
  - `report` / demo JSON outputs → pretty-printed
- **All agents callable**: `router`, `orchestrator`, `expert_connectomics`,
  `expert_bci_eeg`, the `paper_feed` pipe agent (topic + duration inputs,
  live event feed with a Stop-stream button), the free `star_map_demo` agent
  (instant LLM-free answers + a downloadable `star-map-demo.html`), and the
  A2A demo trio (`my_echo`, `my_adder`, `my_orchestrator`).
- **One agent is free**: `star_map_demo` — no balance needed. The rest are
  paid ($0.02/task, 3 free trial tasks) — sign in with a Blocks account and
  top up if you hit the trial limit.

The scaffold's auth block (`whenBlocksAuthReady`, `attemptSignIn`,
auto-resume, sign-out, error mapping) is kept verbatim; only the UI below it
was rewritten.

## Local development

```bash
cd ui
blocks dev        # → http://localhost:4242 with hot reload
```

`blocks dev` serves `web/` and injects `__blocks_embed_dev.js`, which the
widget reads to target the production backend during development — the full
OAuth flow works locally. `blocks login` is not required for the dev server.

## Deploy

```bash
cd ui
blocks deploy cloudflare      # or vercel / netlify
```

The CLI resolves partner credentials from the platform env var
(`CLOUDFLARE_API_TOKEN`, `VERCEL_TOKEN`, `NETLIFY_AUTH_TOKEN`) or prompts
once and stores them in `~/.config/blocks/credentials.json`.

> **Cloudflare token requirements**: the token must include exactly
> `Account > Cloudflare Pages > Edit` and `Account > Account Settings > Read`
> permissions. A token that merely verifies its own identity returns
> **HTTP 403** on the Pages project lookup. If the token is scoped to a single
> account and can't list accounts, also set `CLOUDFLARE_ACCOUNT_ID`.

After a successful deploy the CLI offers to register the live URL on each
agent's `identity.webApps` (use `--no-card-update` to skip) — that
advertises the UI on the agent's catalog page on Blocks Network.

**Live deployment (verified):** `https://ui-c7w.pages.dev` (Cloudflare
Pages). `ui/blocks.config.json` records `deployTarget: cloudflare` and
`lastDeployedUrl`. The URL is registered in `identity.webApps` on all 9 agent
cards and confirmed in the registry.

> **Headless note:** the card-update prompt reads the terminal, not piped
> stdin — `printf 'y' | blocks deploy` silently skips it. If it's skipped,
> add `identity.webApps: [{ url, label: "ui" }]` to each card yourself and
> re-publish with the agent's normal `blocks publish` flags.

## Refresh against a changed agent card

`blocks init` snapshots each agent's card into `web/app.js` at scaffold time.
If an agent's inputs/outputs/streams change, regenerate in a fresh directory
(all these agents are public + free, so no private-listing flip is needed)
and re-apply the UI customization:

```bash
blocks init ui2 --mode webapp --agent router --agent orchestrator \
  --agent expert_connectomics --agent expert_bci_eeg --agent paper_feed \
  --agent my_echo --agent my_adder --agent my_orchestrator -y
```
