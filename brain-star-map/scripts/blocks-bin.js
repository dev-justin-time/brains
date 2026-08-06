// Locate the blocks CLI binary across platforms.
// Resolution order: BLOCKS_BIN env -> ~/.blocks/bin -> ~/.local/bin -> PATH.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export function findBlocksBin() {
  if (process.env.BLOCKS_BIN) {
    const configured = process.env.BLOCKS_BIN
    // Accept either an absolute/relative executable path or a command name
    // resolved by the child-process API (useful for CI and developer PATHs).
    if (fs.existsSync(configured) || !path.isAbsolute(configured)) return configured
  }
  const home = os.homedir()
  const exe = process.platform === 'win32' ? 'blocks.exe' : 'blocks'
  const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const candidates = [
    path.join(home, '.blocks', 'bin', exe),
    path.join(home, '.local', 'bin', exe),
    // The npm package ships the native executable as an optional platform
    // package, without a node_modules/.bin shim in some npm/Windows installs.
    path.join(projectRoot, 'node_modules', '@blocks-network', `cli-${process.platform}-${process.arch}`, exe),
    exe, // rely on PATH
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return 'blocks'
}
