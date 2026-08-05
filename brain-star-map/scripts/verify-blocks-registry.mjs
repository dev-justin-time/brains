// Verify the published agent on the Blocks Network registry and print what
// the network returns for it (docs/reference script).
import 'dotenv/config'
import { getAgent, fetchAgentRegistry } from '@blocks-network/sdk'

// Base URL from the Blocks CDM config (~/.blocks/config.json api.baseUrl).
const BASE_URL = process.env.BLOCKS_BASE_URL || 'https://app.blocks.ai'
const agentName = process.argv[2] || 'router'

console.log(`=== getAgent("${agentName}") ===`)
const entry = await getAgent(agentName, { apiKey: process.env.BLOCKS_API_KEY, baseUrl: BASE_URL })
console.log(JSON.stringify(entry, null, 2))

console.log(`\n=== fetchAgentRegistry() — listing (public) ===`)
const reg = await fetchAgentRegistry({ limit: 20, baseUrl: BASE_URL })
console.log('totalCount:', reg.totalCount)
for (const a of reg.agents || []) {
  console.log(`- ${a.agentName}  (${a.listing}, ${a.billingMode})  ${a.displayName ?? ''}`.trim())
}
