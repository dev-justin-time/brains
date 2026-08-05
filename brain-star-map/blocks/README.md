# Blocks Network — Agent Setup

The brain-tech **expert agents** are packaged as [Blocks Network](https://blocks.ai)
agents. Each specialist (plus a coordinating router) is a self-contained agent
with an `agent-card.json`, built on the official `@blocks-network/sdk`.

```
blocks/
├── lib/
│   ├── handler.js        # the Blocks handler (default export) — shared by every agent
│   └── engine.js         # pipeline: requestParts, streaming, expert + router execution
├── agents/
│   ├── router/                   agent-card.json  — cross-topic coordinator
│   ├── expert_bci_eeg/           agent-card.json  — BCI & EEG Expert
│   ├── expert_neural_decoding/   agent-card.json  — Neural Decoding Expert
│   ├── expert_connectomics/      agent-card.json  — Connectomics Expert
│   ├── expert_deep_learning/     agent-card.json  — Deep Learning Expert
│   ├── expert_clinical_apps/     agent-card.json  — Clinical Apps Expert
│   └── expert_other/             agent-card.json  — Other Expert
└── test-local.mjs       # offline handler test harness (no network needed)
```

Cards are **generated from the corpus data** (`npm run blocks:cards` reads the
SQLite roster), so topics, paper counts, keywords and example questions always
match the actual database — the same data the web app visualizes.

## Key concepts, mapped

| Blocks concept | Implementation |
|---|---|
| **Agent** | 7 agents: 6 topic experts + 1 router. All share one handler; the network targets an agent by `identity.agentName` and the handler resolves it from `task.agentName`. |
| **Agent card** | `agent-card.json` per agent — identity, capabilities, io, streams, tags, runtime (see below). |
| **Task (request)** | Each card declares `capabilities.taskKinds: ["request"]` — single question in, answer out. |
| **requestParts / partId** | Input declared as `io.inputs[].id = "question"`. Callers send `requestParts: [{ partId: "question", text: "…" }]`. A missing/mismatched part fails the task fast (`failed` state). |
| **Task lifecycle** | `pending` (submitted) → `running` (handler starts; SDK auto-publishes the first `{type:'progress', progress:0, state:'running'}`) → `completed` (artifacts returned) / `failed` (handler throws) / `canceled` (`ctx.cancelSignal` — streamed calls abort cooperatively). |
| **Progress events** | `ctx.reportStatus(msg)` on every pipeline stage (cache hit, routing, expert working, consult, merge). |
| **Artifacts** | `{ outputId: "answer", mimeType: "text/plain" }` + `{ outputId: "sources", mimeType: "application/json", fileName: "sources.json" }` — matching `io.outputs`. Small artifacts inline; large ones are uploaded automatically by the SDK. |
| **Streams** | Outbound `bytes` stream declared as `streams._default`; the handler streams answer tokens via `ctx.createStream({ direction:'outbound', format:'bytes' })` and `stream.write(token)`. |
| **Visibility** | Set at publish time: `blocks register` = private + free; `blocks publish --visibility public` to list in the catalog. |
| **Communication + DB** | The router coordinates the specialists and both the web server and agents read/write the same SQLite DB (`data/agents.db`) — shared popular-question cache and the `agent_messages` log record every router→expert consult. |

## Quick start

```bash
# 1. Build the data + regenerate cards (cards derive from the DB roster)
npm run build-agent-db
npm run blocks:cards

# 2. Validate every card against the official Blocks schema (offline)
npm run blocks:check
# → runs `blocks check` on all 7 agent-card.json files

# 3. Prove the handler contract locally — no network required
npm run blocks:test                 # router + full pipeline (real Ollama)
npm run blocks:test:expert          # Connectomics Expert directly
node blocks/test-local.mjs --agent=expert_bci_eeg --question="Best EEG motor-imagery decoders?"
node blocks/test-local.mjs --expect-error   # input contract enforcement
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
- **Invites** (private agents / A2A): `blocks invite`.
- Each agent directory is its own deployment (one `agent-card.json` per dir);
  deploy any card the same way.

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
