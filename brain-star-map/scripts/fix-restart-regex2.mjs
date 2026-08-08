// One-shot fixer (round 2): line 137 still had `(\\\\.exe)?` (double-escaped).
// Repair to `(\\.exe)?` and verify regex behavior before/after.
import fs from 'node:fs'

const p = 'scripts/restart-agents.js'
let s = fs.readFileSync(p, 'utf8')

const old = `(/blocks(\\\\\\.exe)?$/i` // raw: (/blocks(\\.exe)?$/i
const next = `(/blocks(\\\\.exe)?$/i` // raw: (/blocks(\.exe)?$/i

// Behavior sanity check on the FIXED pattern (what the file should contain):
const fixed = new RegExp(`^blocks(\\\\.exe)?$`, 'i')
const results = [fixed.test('blocks.exe'), fixed.test('blocks'), fixed.test('node.exe')]
console.log('fixed regex behavior (blocks.exe / blocks / node.exe):', results.join(' / '))
if (!results[0] || !results[1] || results[2]) {
  console.error('unexpected regex behavior; aborting without writing')
  process.exit(1)
}

if (!s.includes(old)) {
  console.error('PATTERN NOT FOUND — nothing to fix (already correct?)')
} else {
  s = s.replace(old, next)
  fs.writeFileSync(p, s)
  console.log('fixed line 137 regex literal')
}
