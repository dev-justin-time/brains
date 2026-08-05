// Watchdog for a Blocks agent — keeps it running and serving tasks.
//
// Runs `blocks run` for one agent (default: router) and restarts it whenever
// it exits, so the agent keeps serving tasks across crashes. Designed to be
// launched by Windows Task Scheduler at logon (see the setup task below) or
// run manually.
//
//   - PID lock: a lock file prevents two watchdogs (and thus two agent
//     instances) for the same agent — the cards declare expectedInstances: 1,
//     so a second instance would fight over the registry entry.
//   - Restart policy: restart on ANY exit (crash or clean) with exponential
//     backoff (5s -> 120s), reset after 10 minutes of uninterrupted uptime.
//   - Logging: agent output + watchdog events are appended to
//     blocks/logs/<agent>-watchdog.log.
//   - Graceful stop: SIGINT / SIGTERM stop the child and exit without
//     restarting.
//
// Usage:  node scripts/watch-blocks-agent.js [agentName]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBlocksBin } from './blocks-bin.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const name = process.argv[2] || 'router'

// Resolve the agent directory (generated cards or the A2A demo dir).
const candidates = [
  path.join(ROOT, 'blocks', 'agents', name),
  path.join(ROOT, 'blocks', 'a2a-demo', name),
]
const dir = candidates.find(d => fs.existsSync(path.join(d, 'agent-card.json')))
if (!dir) {
  console.error(`[watchdog] No agent card for "${name}" in blocks/agents or blocks/a2a-demo.`)
  console.error('Regenerate cards with `npm run blocks:cards` first.')
  process.exit(1)
}

const bin = findBlocksBin()
if (!fs.existsSync(bin)) {
  console.error('[watchdog] blocks CLI not found. Install it or set BLOCKS_BIN.')
  process.exit(1)
}

// ---------- logging ----------
const LOG_DIR = path.join(ROOT, 'blocks', 'logs')
fs.mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = path.join(LOG_DIR, `${name}-watchdog.log`)
const log = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`
  fs.appendFileSync(LOG_FILE, line)
  console.log(line.trimEnd())
}

// ---------- PID lock (one watchdog per agent) ----------
const LOCK_FILE = path.join(LOG_DIR, `${name}.watchdog.pid`)
// Child PID file — lets operators (and tests) find the live agent process.
const CHILD_PID_FILE = path.join(LOG_DIR, `${name}.child.pid`)
function pidAlive(pid) {
  try {
    process.kill(pid, 0) // signal 0 = existence check only
    return true
  } catch (err) {
    return err.code === 'EPERM' // exists but not ours to signal
  }
}
function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10)
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
      console.error(`[watchdog] Another watchdog for "${name}" is running (pid ${pid}). Exiting.`)
      process.exit(0)
    }
    // Stale lock (dead pid) — take it over.
    fs.unlinkSync(LOCK_FILE)
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid))
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10) === process.pid) {
      fs.unlinkSync(LOCK_FILE)
    }
  } catch (_) { /* best effort */ }
}

// ---------- restart policy ----------
const BASE_DELAY_MS = 5_000
const MAX_DELAY_MS = 120_000
const UPTIME_RESET_MS = 10 * 60_000
let delayMs = BASE_DELAY_MS
let startedAt = 0

let stopping = false
let child = null
let restartScheduled = false

// Schedule exactly one restart. Both the child 'exit' and 'error' events can
// fire for the same failure (documented Node behavior), so without this guard
// two launches could run and spawn two agent instances fighting over
// expectedInstances: 1.
function scheduleRestart() {
  if (stopping || restartScheduled) return
  restartScheduled = true
  log(`restarting in ${Math.round(delayMs / 1000)}s…`)
  setTimeout(() => {
    restartScheduled = false
    launch()
  }, delayMs)
  delayMs = Math.min(delayMs * 2, MAX_DELAY_MS)
}

function stop(signal) {
  if (stopping) return
  stopping = true
  log(`received ${signal} — stopping agent, no restart`)
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
  }
  setTimeout(() => { releaseLock(); process.exit(0) }, 500)
}
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('exit', releaseLock)

function launch() {
  if (stopping) return
  startedAt = Date.now()
  log(`starting "blocks run" for ${name} (${dir})`)
  child = spawn(bin, ['run'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  if (child.pid) fs.writeFileSync(CHILD_PID_FILE, String(child.pid))

  child.stdout.on('data', chunk => fs.appendFileSync(LOG_FILE, chunk))
  child.stderr.on('data', chunk => fs.appendFileSync(LOG_FILE, chunk))

  child.on('exit', (code, signal) => {
    try { fs.unlinkSync(CHILD_PID_FILE) } catch (_) { /* already gone */ }
    const uptimeSec = Math.round((Date.now() - startedAt) / 1000)
    log(`agent exited code=${code} signal=${signal} after ${uptimeSec}s`)

    if (stopping) return
    if (uptimeSec * 1000 >= UPTIME_RESET_MS) delayMs = BASE_DELAY_MS
    scheduleRestart()
  })

  child.on('error', err => {
    log(`spawn error: ${err.message}`)
    try { fs.unlinkSync(CHILD_PID_FILE) } catch (_) { /* already gone */ }
    if (!stopping) scheduleRestart()
  })
}

// ---------- main ----------
acquireLock()
log(`watchdog up for "${name}" (pid ${process.pid}), lock=${LOCK_FILE}`)
log(`blocks bin: ${bin}`)
launch()
