# Blocks Network — Agent Setup

The brain-tech **expert agents** are packaged as [Blocks Network](https://blocks.ai)
agents. Each specialist (plus a coordinating router) is a self-contained agent
with an `agent-card.json`, built on the official `@blocks-network/sdk`.

```
blocks/
├── lib/
│   ├── handler.js        # the Blocks handler (default export) — shared by every agent
│   ├── engine.js         # pipeline: requestParts, streaming, expert + router execution
│   ├── a2a.js            # agent-to-agent: sub-task calls, parallel fan-out, merge
│   └── pipe.js           # pipe-streaming: paper_feed long-lived event session
├── agents/
│   ├── router/                   agent-card.json  — cross-topic coordinator
│   ├── orchestrator/             agent-card.json  — A2A fan-out over the network (generated)
│   ├── paper_feed/               agent-card.json  — pipe agent: live corpus event stream (generated)
│   ├── star_map_demo/            agent-card.json  — FREE demo agent: LLM-free answers + demo.html artifact (generated)
│   ├── expert_bci_eeg/           agent-card.json  — BCI & EEG Expert
│   ├── expert_neural_decoding/   agent-card.json  — Neural Decoding Expert
│   ├── expert_connectomics/      agent-card.json  — Connectomics Expert
│   ├── expert_deep_learning/     agent-card.json  — Deep Learning Expert
│   ├── expert_clinical_apps/     agent-card.json  — Clinical Apps Expert
│   └── expert_other/             agent-card.json  — Other Expert
├── a2a-demo/
│   ├── my_echo/           agent-card.json + handler.js — reference A2A demo agent
│   ├── my_adder/          agent-card.json + handler.js — reference A2A demo agent
│   └── my_orchestrator/   agent-card.json + handler.js + trigger.mjs — calls echo + adder
├── test-local.mjs       # offline handler test harness (no network needed)
├── test-a2a.mjs         # offline A2A contract harness (mocked taskClient)
└── test-pipe.mjs        # offline pipe-streaming contract harness (mocked ctx)

ui/                          # deployable webapp for all agents (see below)
└── web/{index.html,app.js,styles.css} + blocks.config.json
```

Cards are **generated from the corpus data** (`npm run blocks:cards` reads the
SQLite roster), so topics, paper counts, keywords and example questions always
match the actual database — the same data the web app visualizes.

## Key concepts, mapped

| Blocks concept | Implementation |
|---|---|
| **Agent** | 9 generated agents: 6 topic experts + 1 router + 1 orchestrator + 1 free demo (`star_map_demo`), plus 3 reference demo agents (`blocks/a2a-demo/`). All share one handler; the network targets an agent by `identity.agentName` and the handler resolves it from `task.agentName`. |
| **Agent card** | `agent-card.json` per agent — identity, capabilities, io, streams, tags, runtime (see below). |
| **Task (request)** | Each card declares `capabilities.taskKinds: ["request"]` — single question in, answer out. |
| **requestParts / partId** | Input declared as `io.inputs[].id = "question"`. Callers send `requestParts: [{ partId: "question", text: "…" }]`. A missing/mismatched part fails the task fast (`failed` state). |
| **Task lifecycle** | `pending` (submitted) → `running` (handler starts; SDK auto-publishes the first `{type:'progress', progress:0, state:'running'}`) → `completed` (artifacts returned) / `failed` (handler throws) / `canceled` (`ctx.cancelSignal` — streamed calls abort cooperatively). |
| **Progress events** | `ctx.reportStatus(msg)` on every pipeline stage (cache hit, routing, expert working, consult, merge). |
| **Artifacts** | `{ outputId: "answer", mimeType: "text/plain" }` + `{ outputId: "sources", mimeType: "application/json", fileName: "sources.json" }` — matching `io.outputs`. Small artifacts inline; large ones are uploaded automatically by the SDK. |
| **Streams (request)** | Outbound `bytes` stream declared as `streams._default`; the handler streams answer tokens via `ctx.createStream({ direction:'outbound', format:'bytes' })` and `stream.write(token)`. |
| **Streams (pipe)** | `paper_feed` declares `streams.feed` (events, `affinity: dedicated`) + `capabilities.taskKinds: ["pipe"]`; the handler opens it with `ctx.createStream({ format:'events', declaredStream:'feed' })` and streams paper events until `cancelSignal`/`isExpired`. |
| **Visibility** | Set at publish time: `blocks register` = private + free; `blocks publish --visibility public` to list in the catalog. |
| **A2A (agent-to-agent)** | Any agent can call any agent. The SDK injects a pre-authenticated `ctx.taskClient` into every handler — the `orchestrator` uses it to fan out sub-tasks to specialists over the network and merge the results (see the A2A section below). |
| **Communication + DB** | The router coordinates the specialists and both the web server and agents read/write the same SQLite DB (`data/agents.db`) — shared popular-question cache and the `agent_messages` log record every router→expert consult. |

## Quick start

```bash
# 1. Build the data + regenerate cards (cards derive from the DB roster)
npm run build-agent-db
npm run blocks:cards

# 2. Validate every card against the official Blocks schema (offline)
npm run blocks:check
# → runs `blocks check` on all cards (8 generated + 3 A2A demo)

# 3. Prove the handler contract locally — no network required
npm run blocks:test                 # router + full pipeline (real Ollama)
npm run blocks:test:expert          # Connectomics Expert directly
node blocks/test-local.mjs --agent=expert_bci_eeg --question="Best EEG motor-imagery decoders?"
node blocks/test-local.mjs --expect-error   # input contract enforcement

# 4. Prove the A2A contract locally — mocked taskClient, no network
npm run blocks:a2a:test

# 5. Prove the pipe-streaming contract locally — mocked ctx, no network
npm run blocks:pipe:test
```

## Going live on the network

The `router` agent has been registered and published (public + free) on the
real Blocks Network — here is the exact, verified procedure and what each
step returns.

### 1. Authenticate

```bash
blocks login --write-env
```

Opens a browser OAuth flow (Google/GitHub). On success it prints:

```text
✓ Logged in to Blocks Network (profile: blocks-network)
  API key: bk_…
  <project>/.env created with BLOCKS_API_KEY
```

Verify with `blocks whoami` → returns the profile and org:

```text
  Profile:  blocks-network
  Org:      justin
  Org ID:   019f443a-d57c-751f-bd3f-de48dcfac330
```

The `.env` written to the project root is gitignored. **Each agent dir needs
the key too** (the runtime loads `.env` from its own directory):

```bash
cp .env blocks/agents/router/.env
```

### 2. Register (private + free)

```bash
cd blocks/agents/router && blocks register --org-name <your-org>
```

(`--org-name` is prompted interactively on first use if omitted; pass it to
avoid the prompt in scripts.) Runs the full card validation, then publishes
it privately (only orgs you invite can use it) with no billing. It returns:

```text
[OK] agent-card.json found
[OK] Passes JSON Schema validation
[OK] identity.agentName: router
[OK] Handler found: ../../lib/handler.js
…
Congratulations! router is published to Blocks Network.
Visibility: Private
Billing: Free
Next: invite organizations before they can use this agent.
```

### 3. Publish (public + free)

```bash
cd blocks/agents/router && blocks publish --listing public --billing-mode free --accept-terms --org-name <your-org>
```

`--accept-terms` accepts the legal attestations (needed for non-interactive
runs). It returns:

```text
Congratulations! router is published to Blocks Network.
Visibility: Public
Billing: Free
Next: keep your agent running so consumers can use it.
```

### 4. Run the agent (keep it live)

```bash
cd blocks/agents/router && blocks run     # or: npm run blocks:run
```

Connects the instance to the network (PubNub) and waits for tasks. It logs:

```text
[blocks-run] starting "Router — Research Coordinator" (router)
… registry billingMode: free — using playground environment
[AgentInstance] Agent instance AG-router-7d667bc4-928b-432d-b3ad-6f504b02f28a started
```

Leave this process running for consumers to reach the agent. Stop it with
`Ctrl+C` or `taskkill //IM blocks.exe //F`.

### 4b. Run as a service (auto-start + crash recovery)

A plain `blocks run` dies with its terminal. To keep the router serving across
reboots and crashes there's a watchdog supervisor:

```bash
node scripts/watch-blocks-agent.js router   # supervised `blocks run`
```

- **PID lock** — one watchdog per agent (cards declare `expectedInstances: 1`,
  so a second instance would fight over the registry entry).
- **Restart with backoff** — restarts on ANY exit, 5s → 120s, resets after
  10 minutes of uninterrupted uptime.
- **Child PID file** — `blocks/logs/router.child.pid` points at the live agent
  process, so scripts/tests can target it (e.g. to prove recovery).
- **Logs** — agent output + watchdog events append to
  `blocks/logs/router-watchdog.log`.

**Auto-start at logon (no admin needed).** Task Scheduler registration is
admin-gated on this machine (`Access is denied` for both `schtasks /Create`
and `Register-ScheduledTask` as a standard user), so the watchdog is launched
from the Windows Startup folder instead — the standard per-user mechanism:

```bash
# installed at: %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\BrainStarMap Router.vbs
# source kept in the repo: scripts/start-router-at-logon.vbs
```

The VBS runs `watch-blocks-agent.js router` hidden at every logon. To verify
recovery after a crash:

```bash
taskkill //F //PID $(cat blocks/logs/router.child.pid) && sleep 12
tail -5 blocks/logs/router-watchdog.log   # "agent exited … restarting in 5s…"
node scripts/call-blocks-agent.mjs router "How many papers are in the corpus?"
```

If you later get an admin shell, register the same watchdog as a proper
scheduled task instead of the Startup folder:

```powershell
$a = New-ScheduledTaskAction -Execute 'C:\Program Files\nodejs\node.exe' `
  -Argument '"C:\Users\dividicus\Downloads\brains\brain-star-map\scripts\watch-blocks-agent.js" router' `
  -WorkingDirectory 'C:\Users\dividicus\Downloads\brains\brain-star-map'
Register-ScheduledTask -TaskName 'BrainStarMap Router' -Action $a `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn) `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)) -Force
```

### 5. Verify the registry entry

```bash
npm run blocks:registry      # → node scripts/verify-blocks-registry.mjs router
```

Fetches the agent card from the registry API — returns the full card
(identity, io inputs/outputs, streams, tags, listing, billingMode) plus the
public registry listing.

### 6. Call it as a consumer (what comes back)

```bash
npm run blocks:call -- router "What are graph neural networks used for in connectomics?"
```

Submits a real task over the network via the SDK `TaskClient`. What comes
back, in order:

```text
Calling "router" with: What are graph neural networks used for in connectomics?

[progress] running
[progress] Routing "…" to the specialist network…
[progress] Routing question to expert agent(s)…
[progress] Connectomics Expert is working…
<answer streamed token-by-token over the network>
[artifact] answer
[artifact] sources
[terminal] state=completed
[artifacts] 2 returned
--- artifact (1294 chars) ---   # the cited answer, e.g. with [2][3][4] references
--- sources.json (945 chars) --- # [{ title, year, url }] of the cited papers
```

### Notes

- **Anonymous quota**: public + free agents can be tried from the browser
  without an account up to 20 tasks per device (never resets). Authenticated
  callers are not quota-limited.
- **Going private again**: `blocks publish --listing private --billing-mode free`.
- **Paid**: `blocks publish --listing public --billing-mode paid --price <usd>`
  (per task or per minute, 85/15 split, Stripe).
- **Rotating the API key**: `blocks login --write-env` rewrites `BLOCKS_API_KEY`
  in the root `.env` (prints the new `bk_…` key). Every agent dir keeps its own
  copy, so after rotating run:
  `cp .env blocks/agents/*/.env blocks/a2a-demo/*/.env`, then restart the
  agents (instances load the key at startup; the router restarts itself via the
  watchdog).
- **Invites** (private agents): `blocks invite` — see
  [Private access — invites & grants](#private-access--invites--grants-verified).
- Each agent directory is its own deployment (one `agent-card.json` per dir);
  deploy any card the same way.

## A2A — live on the network (verified)

The A2A layer (`blocks/lib/a2a.js`) follows the official *Set Up Agent-to-Agent
(A2A) Communication* guide:

- **`ctx.taskClient` is pre-authenticated** — the SDK exchanges the agent's API
  key for a consumer JWT; orchestrators call any agent with `sendMessage()`.
- **Omit `ownerId`** on sub-tasks — passing the original caller's `task.ownerId`
  causes a `PermissionDenied` error (sub-tasks are owned by the orchestrator).
- **Inline artifacts are base64** — decoded with `decodeInlineArtifact()`.
- **Partial failures are OK** — a specialist that fails or times out produces a
  partial merged brief, never a failed task.
- **Timeouts**: sub-task timeout (240s) stays under the orchestrator card's
  `maxRunningTimeSec` (300s) to leave room for result assembly. The 120s
  default was too tight — live specialist LLM generations measured 150-210s.

Two orchestrators were registered, published (public + free) and run live on
Blocks Network; both were called end-to-end as consumers:

### 1. Demo trio — `my_orchestrator` → `my_echo` + `my_adder`

The docs' exact reference pattern: two specialists in parallel, one merged
artifact. `node blocks/a2a-demo/my_orchestrator/trigger.mjs` returned:

```json
{ "echo":  { "status": "completed", "artifacts": [{ "outputId": "echo",  "data": "Echo: Hello!" }] },
  "adder": { "status": "completed", "artifacts": [{ "outputId": "sum",   "data": { "sum": 7, "a": 3, "b": 4 } }] },
  "summary": "Echo: completed, Adder: completed" }
```

### 2. Domain orchestrator — `orchestrator` → topic experts

`npm run blocks:call -- orchestrator "What are graph neural networks used in
connectomics?"` picked the top-2 specialists offline (same keyword-affinity
routing as the router, via `scoreTopicAffinity`), fanned out over the network,
and returned **3 artifacts**: a merged `answer` brief, a deduped `sources`
list (6 cited papers), and a structured `report` (per-specialist status).

```text
[progress] Fanning out to 2 specialist(s) in parallel: expert_connectomics, expert_bci_eeg
[progress] expert_connectomics: completed (2 artifacts)
[progress] Merged 2/2 specialist answers.
[artifact] answer · sources · report      [terminal] state=completed
```

Try it yourself:

```bash
npm run blocks:a2a:test      # offline contract harness (mocked taskClient)
npm run blocks:a2a:demo:call # live: my_orchestrator -> my_echo + my_adder
npm run blocks:call -- orchestrator "<question>"   # live: orchestrator -> experts
```

## Private access — invites & grants (verified)

Private agents (`--listing private`) are only callable by parties you grant
access to. Access is managed through **invitations**, which the invitee must
**accept** before a grant is created. The full lifecycle below was verified
live against a throwaway private agent (`grant_demo` — registered, invited,
revoked, then deleted; the live public agents were never touched).

### 1. Register a private agent

```bash
cd blocks/agents/<agent> && blocks register --org-name <org>
```

Returns: `Visibility: Private` and `Next: invite organizations before they
can use this agent.` (register publishes private + free by default).

### 2. Send an invitation — by user email or org slug

```bash
blocks invite send <agentName> --email partner@example.com   # by user
blocks invite send <agentName> --org <org-slug>              # by organization
```

Output: `Invitation sent to partner@example.com`

### 3. See the pending invitation

```bash
blocks invite list <agentName>
```

```text
ID                                    EMAIL                         SCOPE  CREATED                   EXPIRES
019fd36b-44fc-7089-b459-7f56a5b5ced0  partner@example.com           user   2026-08-05T19:34:10.353Z  2026-08-12T19:34:10.315Z
```

Invitations **expire after 7 days** (the `EXPIRES` column).

### 4. Grants appear only after the invitee accepts

```bash
blocks invite grants <agentName>   # → "No active grants." until accepted
```

The invitee accepts from their own Blocks account (`blocks invite accept`).
Until they do, the invite stays pending and there is no grant.

### 5. Revoking access

```bash
blocks invite revoke <agentName> --email partner@example.com   # or --org <org-slug>
```

**Note (verified):** `revoke` only works on **active grants**. A *pending*
invite cannot be cancelled from the CLI — it errors with `no active grant
found` and the invite stays listed until it expires (7 days).

### 6. Cleaning up a throwaway private agent

Stop the running instance, then delete the registry entry — its pending
invites become unreachable with it (the agent 404s on `invite list`
afterwards):

```bash
taskkill //F //PID <instance-pid>
node scripts/remove-blocks-agent.mjs <agentName>   # SDK removeAgent()
```

### Invites vs. the live agents

All 9 live agents (router, orchestrator, experts, `paper_feed`,
`star_map_demo`, demo trio) are **public** — public agents need no invites;
any authenticated caller can use them. To gate one behind this invite flow,
flip it private: `blocks publish --listing private --billing-mode paid`.

## Streaming — request + pipe (live on the network)

All research agents stream answer tokens over the network (request streaming,
`streams._default`, bytes). The `paper_feed` agent adds **pipe streaming**
(long-lived sessions) following the Blocks *Stream data* guide:

- **Card**: `capabilities.taskKinds: ["pipe"]` + a dedicated `streams.feed`
  (events, `affinity: dedicated`). Pipe agents must use a named stream key
  (not `_default`) and the handler must open the same key.
- **Handler** (`blocks/lib/pipe.js`): validates the task is a pipe, opens the
  events stream, matches papers against the corpus with the same hybrid
  retrieval as the Q&A agents, and streams one structured event per paper
  (`{ type: 'paper', id, title, year, url, first_author, topic, keywords, at }`)
  on a loop until the caller cancels or the duration expires. A `summary`
  artifact is returned when the session ends.
- **Duration** comes from the caller: `sendMessage({ taskKind: 'pipe', duration })`
  (1 minute – 30 days). `maxRunningTimeSec` is 2,592,000 (30 days) to cover the
  whole session.
- **UI** (webapp) exposes it: pick **Paper Feed**, enter a topic + duration,
  watch papers stream in live, press **Stop stream** to end the session.

Verified end-to-end over the real network (topic "EEG motor imagery", 1 min):

```text
[progress] running
[progress] paper_feed: streaming 40 paper(s) matching "EEG motor imagery"…
[paper] 2025 — Fine-Tuning Strategies for Continual Online EEG Motor Imagery Decoding https://arxiv.org/pdf/2502.06828v1
[paper] 2025 — Motor Imagery EEG Signal Classification Using Minimally Random Convolu …
… (one paper per ~1.5s) …
[stream] received 10 event(s) — then caller canceled
[terminal] state=canceled            [artifact] summary
{ "type": "session_ended", "topic": "EEG motor imagery", "streamed": 10, "poolSize": 40, "ended": "canceled" }
```

Try it yourself:

```bash
npm run blocks:pipe:test               # offline contract harness (mocked ctx)
npm run blocks:pipe:call -- paper_feed "graph neural networks" 2   # live, 2-minute session
```

## star_map_demo — FREE demo agent (live)

`star_map_demo` is published **public + free** — deliberately **LLM-free**, so
it can honestly be free and answers instantly. It reuses the web app's
`directLookup` + hybrid retrieval (`server/search.js`) and always attaches the
interactive 3D star-map page (`public/demo.html`, ~24 KB) as a downloadable
`text/html` file artifact.

```text
> How many papers are in the corpus?
answer: The corpus contains 215 papers across 6 topic areas, connected by 700 keyword-co-occurrence edges.
demo:   star-map-demo.html (24,211 chars) — the full interactive page, downloadable
```

Try it:

```bash
npm run blocks:demo:test              # offline contract harness (mocked ctx)
npm run blocks:demo:call -- star_map_demo "List papers about EEG motor imagery"
```

It is the only **free** agent on the network (all others are $0.02 paid) —
anonymous users can try it from the browser up to the anonymous quota.

## Pricing — live agents are paid ($0.02)

All 8 agents are published **public + paid** on the real network at a flat,
fair **$0.02** (per task for request agents; per minute for `paper_feed`), with
**3 free trial tasks** (or minutes) per consumer organization so anyone can
still try before paying. You keep 85%, Blocks takes 15% (Stripe).

```bash
# Request agent (per task)
blocks publish --listing public --billing-mode paid --price 0.02 --free-tasks 3 --accept-terms
# Pipe agent (per minute)
blocks publish --listing public --billing-mode paid --price 0.02 --free-minutes 3 --accept-terms
```

After changing billing mode, restart the running instances (`blocks run`) so
they pick up the paid registry state. Consumers keep the same SDK calls — paid
agents are charged automatically from the caller's balance. The demo trio
(`my_echo`, `my_adder`, `my_orchestrator`) are also $0.02/task.

## Web UI — deployable research console (`ui/`)

`ui/` is a static webapp scaffolded with `blocks init --mode webapp` for all 7
published agents (router, orchestrator, the two live experts, and the three
A2A demo agents) and then customized into a star-map themed research console.

- **Auth**: Blocks embed-auth widget (OAuth popup, JWT + 24h refresh token,
  auto-resume on reload, per-origin partitioned storage). The scaffold's auth
  plumbing is kept verbatim — only the UI below it was rewritten.
- **Data-driven agent config**: one `AGENTS` table drives the nav chips, input
  fields, and artifact rendering (answer text + styled `[n]` citation markers,
  sources as clickable arXiv cards, orchestrator `report` as pretty JSON).
- **All 7 agents callable**: switch agent via the chips, sign in once
  (`signInAndGetClients`), and each section shows its card's inputs/streams.

### Develop locally

```bash
cd ui && blocks dev        # → http://localhost:4242 (hot reload)
```

The dev server injects `__blocks_embed_dev.js` so the widget points at the
production backend during development — full OAuth flow works locally.

### Deploy to Cloudflare Pages

```bash
cd ui && blocks deploy cloudflare
```

The CLI resolves the token from `CLOUDFLARE_API_TOKEN` (or prompts once and
stores it in `~/.config/blocks/credentials.json`). **The token needs exactly
two permissions**: `Account > Cloudflare Pages > Edit` and
`Account > Account Settings > Read` — a token that only verifies itself
returns HTTP 403 on the Pages project lookup. If the token is scoped to a
single account and cannot list accounts, also set `CLOUDFLARE_ACCOUNT_ID`.

After deploy it offers to register the live URL on each agent's
`identity.webApps` — that advertises the UI on the agent's catalog page.

### Re-scaffolding after a card change

`blocks init` takes a one-time snapshot of each agent's card into `web/app.js`.
If a card's inputs/outputs/streams change, re-run `blocks init` in a fresh
directory against the public listing (all agents here are public + free, so
no private-listing flip is needed) and re-apply the UI customization.

## Contracts

Callers send (request task):

```json
{
  "requestParts": [{ "partId": "question", "text": "What is connectomics?" }]
}
```

Agents respond with:

```json
{
  "artifacts": [
    { "data": "Connectomics is… [1]", "mimeType": "text/plain", "outputId": "answer" },
    { "data": "[{\"title\":\"…\",\"year\":2023,\"url\":\"https://arxiv.org/…\"}]",
      "mimeType": "application/json", "outputId": "sources", "fileName": "sources.json" }
  ]
}
```

While running, `progress` events stream status, and a `_default` bytes stream
carries the answer token-by-token.
