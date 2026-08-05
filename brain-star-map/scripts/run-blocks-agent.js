// Start a Blocks agent locally: `node scripts/run-blocks-agent.js <agentName>`
// Runs `blocks run` inside blocks/agents/<agentName>/ (requires `blocks login` first).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBlocksBin } from './blocks-bin.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const name = process.argv[2] || 'router'
// Resolve from generated cards (blocks/agents) or the A2A demo dir.
const candidates = [
  path.join(__dirname, '..', 'blocks', 'agents', name),
  path.join(__dirname, '..', 'blocks', 'a2a-demo', name),
]
const dir = candidates.find(d => fs.existsSync(path.join(d, 'agent-card.json')))

if (!dir) {
  console.error(`No agent card for "${name}" in blocks/agents or blocks/a2a-demo.`)
  console.error('Regenerate cards with `npm run blocks:cards` first.')
  process.exit(1)
}

const bin = findBlocksBin()
if (!fs.existsSync(bin)) {
  console.error('blocks CLI not found. Install it or set BLOCKS_BIN (e.g. to ~/.blocks/bin/blocks.exe).')
  process.exit(1)
}

console.log(`Starting agent "${name}" from ${dir} (${bin})\n`)
const child = spawn(bin, ['run'], { cwd: dir, stdio: 'inherit' })
child.on('exit', code => process.exit(code ?? 0))
