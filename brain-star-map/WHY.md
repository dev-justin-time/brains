# WHY.md — Publishing `expert_connectomics` public + free

> Read this when you have time. No rush — nothing on the network has been
> changed yet, and nothing will be until you decide.

## 1. What was asked

> "Publish one of the specialist expert agents (e.g. expert_connectomics)
> public + free following the documented steps"

So: take `expert_connectomics`, make it **public** (listed in the Blocks
catalog, anyone can find and call it) and **free** (no per-task charge),
using the steps documented in `blocks/README.md`.

## 2. Current reality — it's not free today

In an earlier round you chose **"Flat $0.02/task"**, so all agents were
re-published as **public + paid $0.02** on the live network.

The registry says, right now:

```
expert_connectomics  →  listing: "public"   billingMode: "paid"
```

So "publish public + free" is really **"downgrade a live paid agent to
free"** — a real billing change. That's why this was flagged instead of just
running the command.

## 3. What happened when the documented steps were followed

I ran the README's exact step 3:

```bash
cd blocks/agents/expert_connectomics
blocks publish --listing public --billing-mode free --accept-terms --org-name justin
```

The CLI validated the card… then **refused**:

```
Visibility: Public
Billing: Free
Error: publish failed: Agent expert_connectomics is already configured as a
Paid agent. Please delete via the Blocks portal before publishing it as a
Free agent.
```

This is not a bug in our setup. The **platform itself forbids downgrading a
paid agent to free in place** (presumably so callers never see a live agent's
billing change under them). I checked `blocks publish --help` — there is no
`--force` / `--downgrade` flag, and the CLI has no delete subcommand. The
platform's own error message prescribes the only path:

> **delete the agent → re-register → re-publish as free**

## 4. The fix (platform-blessed, not a hack)

The SDK exposes `removeAgent()` — the same API the portal's delete button
calls. I've written `scripts/remove-blocks-agent.mjs` that uses it.

The full sequence would be:

| Step | Command | Effect |
|---|---|---|
| 1. Delete the paid entry | `node scripts/remove-blocks-agent.mjs expert_connectomics` | Removes the agent from the registry |
| 2. Re-register | `blocks register --org-name justin` (in the agent dir) | Creates it again — private + free |
| 3. Re-publish | `blocks publish --listing public --billing-mode free --accept-terms` | Makes it public + free |
| 4. Restart the instance | `blocks run` | Picks up the free billing state |
| 5. Verify | `npm run blocks:registry` | Confirms `billingMode: free` |
| 6. Call it | `npm run blocks:call -- expert_connectomics "..."` | Confirms it still answers |

The agent card lives in the repo (`blocks/agents/expert_connectomics/`), so
**nothing is lost locally** — deletion only touches the registry entry.

## 5. Trade-offs — what free actually means

**Upside of going free:**
- Anyone can try `expert_connectomics` from the browser **without a Blocks
  account** (up to 20 anonymous tasks per device).
- Good for a public demo / portfolio / research showcase.
- No billing surprises for the people calling it.

**Downside of going free:**
- It stops earning **$0.02/task** (you keep 85% of that).
- The old paid entry's registry stats/history are wiped by the delete.
- The other 7 agents stay paid, so this one becomes the "free demo" odd one
  out unless that's intentional.

## 6. Why the platform blocks paid → free in place

Most likely policy: an agent that has been published with a price is treated
as a committed billing configuration. Allowing an in-place downgrade could:
- change what callers are charged mid-flight, and
- let someone game paid-caller expectations.

So the platform only allows *register → publish free → publish paid*, and
requires a delete to go backwards. (Paid → paid with a *different price* and
free → paid are handled differently — only paid → free needs the delete.)

## 7. Options (pick any)

1. **Delete + re-publish free** — I run the 6 steps above. Net result:
   `expert_connectomics` is public + free, exactly as requested.
2. **Pick a different agent** — keep `expert_connectomics` paid; publish a
   different specialist (e.g. `expert_bci_eeg`) free instead.
3. **You delete it in the portal yourself** — delete at app.blocks.ai, then
   tell me and I'll re-register + re-publish free + verify.
4. **Cancel** — leave everything public + paid $0.02 as it is.

## 8. Nothing has changed on the network

As of this writing the live state is untouched:
- All 8 agents: **public + paid $0.02** (router, orchestrator, paper_feed,
  expert_connectomics, expert_bci_eeg, my_echo, my_adder, my_orchestrator)
- All 8 agent instances are running (9 `blocks.exe` processes incl. the UI
  dev server)
- The only repo change is this file + the prepared `remove-blocks-agent.mjs`
  helper, which does nothing until you run it.

Come back here when you've read this and tell me which option (1–4) you want.
