// Supervisor for the Blocks agent network — keeps EVERY agent card running.
//
// Spawns one per-agent watchdog (scripts/watch-blocks-agent.js) for each card
// in blocks/agents/ and blocks/a2a-demo/, so every agent gets crash-restart
// with exponential backoff, PID-lock safety, and per-agent logs. The whole
// network is then brought back after a reboot by a Windows logon Startup
// folder entry (see blocks/README.md "4c") that runs this script.
//
//   - Detects agents by scanning for agent-card.json at startup (no hardcoded
//     list). Restart the supervisor to pick up newly added cards.
//   - PID lock: one supervisor per machine (blocks/logs/supervisor.pid).
//   - Per-agent backoff (5s -> 60s), reset to 5s after a child has stayed up
//     for 10+ minutes — a crash-looping agent can't slow down other agents'
//     restarts.
//   - A watchdog child that exits code 0 within a few seconds means another
//     watchdog already owns that agent's lock ("already supervised
//     elsewhere") — the supervisor stops managing that agent instead of
//     restart-looping it forever.
//   - A `restartScheduled` flag prevents the double-launch that can happen
//     when both the 'exit' and 'error' events fire for one failure.
//   - Graceful stop: SIGINT / SIGTERM kill each watchdog's process TREE
//     (taskkill /T on Windows, where plain SIGTERM is a hard kill that would
//     orphan the `blocks run` child), then exit.
//
// Usage:  node scripts/supervise-all-agents.js

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const isWin = process.platform === 'win32'

// ---------- discover every agent card ----------
function discoverAgents() {
  const agents = []
  for (const base of ['blocks/agents', 'blocks/a2a-demo']) {
    const dir = path.join(ROOT, base)
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir)) {
      const agentDir = path.join(dir, entry)
      if (fs.statSync(agentDir).isDirectory() && fs.existsSync(path.join(agentDir, 'agent-card.json'))) {
        agents.push(entry)
      }
    }
  }
  return agents.sort()
}

// ---------- logging ----------
const LOG_DIR = path.join(ROOT, 'blocks', 'logs')
fs.mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = path.join(LOG_DIR, 'supervisor.log')
const log = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`
  fs.appendFileSync(LOG_FILE, line)
  console.log(line.trimEnd())
}

// ---------- PID lock (one supervisor per machine) ----------
const LOCK_FILE = path.join(LOG_DIR, 'supervisor.pid')
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}
function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10)
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
      console.error(`[supervisor] Another supervisor is running (pid ${pid}). Exiting.`)
      process.exit(0)
    }
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

const BASE_DELAY_MS = 5_000
const MAX_DELAY_MS = 60_000
const UPTIME_RESET_MS = 10 * 60_000
const FAST_EXIT_MS = 3_000
let stopping = false

const children = new Map() // name -> { child, delayMs, restartTimer, restartScheduled, startedAt }

function scheduleRestart(name) {
  const entry = children.get(name)
  if (!entry || stopping || entry.restartScheduled) return
  entry.restartScheduled = true
  const delay = entry.delayMs
  log(`restarting watchdog for "${name}" in ${Math.round(delay / 1000)}s…`)
  entry.restartTimer = setTimeout(() => {
    entry.restartScheduled = false
    children.delete(name)
    launchWatchdog(name)
  }, delay)
  entry.delayMs = Math.min(entry.delayMs * 2, MAX_DELAY_MS)
}

function killTree(pid) {
  // On Windows, child.kill('SIGTERM') is a hard TerminateProcess that skips
  // the watchdog's signal handler and orphans its `blocks run` child — so kill
  // the whole process tree instead (taskkill /T /F).
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}

function stop(signal) {
  if (stopping) return
  stopping = true
  log(`received ${signal} — stopping all watchdogs, no restarts`)
  for (const [name, entry] of children) {
    clearTimeout(entry.restartTimer)
    if (entry.child && entry.child.exitCode === null) {
      if (isWin) killTree(entry.child.pid)
      else entry.child.kill('SIGTERM')
    } else {
      log(`watchdog for "${name}" already exited`)
    }
  }
  setTimeout(() => { releaseLock(); process.exit(0) }, 1_500)
}
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('exit', releaseLock)

function launchWatchdog(name) {
  if (stopping) return
  const watchdogPath = path.join(__dirname, 'watch-blocks-agent.js')
  const child = spawn(process.execPath, [watchdogPath, name], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const entry = { child, delayMs: BASE_DELAY_MS, restartTimer: null, restartScheduled: false, startedAt: Date.now() }
  children.set(name, entry)
  log(`watchdog up for "${name}" (pid ${child.pid})`)

  child.stdout.on('data', chunk => fs.appendFileSync(LOG_FILE, chunk))
  child.stderr.on('data', chunk => fs.appendFileSync(LOG_FILE, chunk))

  child.on('exit', (code, signal) => {
    const uptimeMs = Date.now() - entry.startedAt
    log(`watchdog for "${name}" exited code=${code} signal=${signal} after ${Math.round(uptimeMs / 1000)}s`)
    if (stopping) return

    // Fast clean exit = another watchdog already owns this agent's lock
    // (watch-blocks-agent.js exits 0 on lock conflict). Don't restart-loop.
    if (code === 0 && uptimeMs < FAST_EXIT_MS) {
      log(`"${name}" is already supervised elsewhere — not managing this agent`)
      children.delete(name)
      return
    }

    if (uptimeMs >= UPTIME_RESET_MS) entry.delayMs = BASE_DELAY_MS
    scheduleRestart(name)
  })
  child.on('error', err => {
    log(`watchdog spawn error for "${name}": ${err.message}`)
    if (!stopping) scheduleRestart(name)
  })
}

// ---------- main ----------
acquireLock()
const agents = discoverAgents()
if (!agents.length) {
  console.error('[supervisor] No agent cards found. Run `npm run blocks:cards` first.')
  releaseLock()
  process.exit(1)
}
log(`supervisor up (pid ${process.pid}) — supervising ${agents.length} agents: ${agents.join(', ')}`)
log(`logs: ${LOG_DIR}`)
for (const name of agents) launchWatchdog(name)
