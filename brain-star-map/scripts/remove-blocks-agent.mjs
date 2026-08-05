// Delete a published Blocks agent from the registry.
//
// The Blocks platform does not allow a Paid agent to be re-published as Free
// in place — the CLI errors with "already configured as a Paid agent. Please
// delete via the Blocks portal before publishing it as a Free agent." This
// script performs that deletion via the SDK's removeAgent() (the same API the
// portal uses), so the agent can then be re-registered + re-published as free.
//
// Usage:  node scripts/remove-blocks-agent.mjs <agentName>
// Requires BLOCKS_API_KEY in .env (created by `blocks login --write-env`).
import 'dotenv/config'
import { removeAgent } from '@blocks-network/sdk'

const BASE_URL = process.env.BLOCKS_BASE_URL || 'https://app.blocks.ai'
const agentName = process.argv[2]

if (!agentName) {
  console.error('Usage: node scripts/remove-blocks-agent.mjs <agentName>')
  process.exit(1)
}
if (!process.env.BLOCKS_API_KEY) {
  console.error('Missing BLOCKS_API_KEY — run `blocks login --write-env` first.')
  process.exit(1)
}

console.log(`Deleting agent "${agentName}" from the registry…`)
const removed = await removeAgent(agentName, { baseUrl: BASE_URL })
console.log(removed ? `✓ Agent "${agentName}" removed.` : `Agent "${agentName}" not found (already gone).`)
process.exit(removed ? 0 : 1)
