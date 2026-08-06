import 'dotenv/config'
import { TaskClient } from '@blocks-network/sdk'
const client = await TaskClient.create({ billingMode: 'free', apiKey: process.env.BLOCKS_API_KEY, baseUrl: process.env.BLOCKS_BASE_URL || 'https://app.blocks.ai' })
const t0 = Date.now()
const session = await client.sendMessage({ agentName: 'ada_harvest', requestParts: [{ partId: 'topic', text: 'quantum game theory' }], stream: false })
const terminal = await session.waitForTerminal(90000)
console.log('terminal:', terminal.state, 'in', Math.round((Date.now()-t0)/1000)+'s')
for (const ref of session.listArtifacts()) {
  const d = await session.downloadArtifact(ref)
  const text = new TextDecoder().decode(d.data)
  console.log('ARTIFACT', ref.outputId ?? '?', 'len=' + text.length)
  if (ref.outputId === 'answer') console.log(text.slice(0, 320))
}
session.asyncClose()
