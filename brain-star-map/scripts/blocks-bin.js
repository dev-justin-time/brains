// Locate the blocks CLI binary across platforms.
// Resolution order: BLOCKS_BIN env -> ~/.blocks/bin -> ~/.local/bin -> PATH.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export function findBlocksBin() {
  if (process.env.BLOCKS_BIN && fs.existsSync(process.env.BLOCKS_BIN)) return process.env.BLOCKS_BIN
  const home = os.homedir()
  const exe = process.platform === 'win32' ? 'blocks.exe' : 'blocks'
  const candidates = [
    path.join(home, '.blocks', 'bin', exe),
    path.join(home, '.local', 'bin', exe),
    exe, // rely on PATH
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return 'blocks'
}
