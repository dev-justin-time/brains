// Validate all generated Blocks agent cards with the official `blocks check`.
//
// Locates the blocks CLI (env BLOCKS_BIN, then ~/.blocks/bin, then PATH) and
// runs `blocks check <card>` for every agent card in blocks/agents/.
// Exits non-zero if any card fails, so `npm run blocks:check` fails loudly.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBlocksBin } from './blocks-bin.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENTS_DIR = path.join(__dirname, '..', 'blocks', 'agents')
const DEMO_DIR = path.join(__dirname, '..', 'blocks', 'a2a-demo')

const collect = (base) => fs.existsSync(base)
  ? fs.readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(base, d.name, 'agent-card.json'))
      .filter(fs.existsSync)
  : []

const cards = [...collect(AGENTS_DIR), ...collect(DEMO_DIR)]

if (!cards.length) {
  console.error('No agent cards found. Run `npm run blocks:cards` first.')
  process.exit(1)
}

const bin = findBlocksBin()
console.log(`Using blocks CLI: ${bin}\n`)
// `findBlocksBin()` may return a bare command name when the CLI is on PATH,
// so fs.existsSync() is not sufficient. Probe through the same child-process
// API used below and only treat an executable-not-found error as missing.
const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' })
if (probe.error?.code === 'ENOENT') {
  console.error('blocks CLI not found. Install it or set BLOCKS_BIN (e.g. to ~/.blocks/bin/blocks.exe).')
  process.exit(1)
}

let failures = 0
for (const card of cards) {
  const r = spawnSync(bin, ['check', card], { encoding: 'utf8' })
  const out = (r.stdout || '').trim().split('\n').slice(-3).join('\n')
  console.log(`== ${path.relative(process.cwd(), card)}`)
  console.log(out)
  if (r.error || r.status !== 0) {
    failures++
    console.log((r.error?.message || r.stderr || '').trim() || '[FAIL]')
  }
  console.log('')
}

if (failures) {
  console.error(`\n${failures} card(s) failed validation.`)
  process.exit(1)
}
console.log(`All ${cards.length} agent cards pass \`blocks check\`.`)
