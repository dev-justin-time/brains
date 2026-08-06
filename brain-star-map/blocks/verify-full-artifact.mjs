import 'dotenv/config'
import { TaskClient } from '@blocks-network/sdk'
const agentName = process.argv[2]
const question = process.argv[3]
const client = await TaskClient.create({ billingMode: 'free', apiKey: process.env.BLOCKS_API_KEY, baseUrl: process.env.BLOCKS_BASE_URL || 'https://app.blocks.ai' })
const session = await client.sendMessage({ agentName, requestParts: [{ partId: 'question', text: question }], stream: false })
const terminal = await session.waitForTerminal(180000)
console.log('terminal:', terminal.state)
for (const ref of session.listArtifacts()) {
  const d = await session.downloadArtifact(ref)
  const text = new TextDecoder().decode(d.data)
  console.log('ARTIFACT', ref.outputId ?? ref.fileName ?? '?', 'len=' + text.length)
  if (ref.outputId === 'skeleton' || ref.outputId === 'review' || ref.outputId === 'draft' || ref.outputId === 'subgraph') {
    const j = JSON.parse(text)
    console.log('  sections:', (j.sections || []).map(s => s.title).join(' | '))
    console.log('  papers:', (j.papers || []).length)
  }
}
session.close(); client.destroy(); process.exit(terminal.state === 'completed' ? 0 : 1)
