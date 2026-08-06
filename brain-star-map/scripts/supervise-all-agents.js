// Supervisor for the Blocks agent network — keeps EVERY agent card running.
//
// Spawns one per-agent watchdog (scripts/watch-blocks-agent.js) for each card
// in blocks/agents/ and blocks/a2a-demo/, so every agent gets crash-restart
// with exponential backoff, PID-lock safety, and per-agent logs. The whole
// network is then brought back after a reboot by a Windows logon scheduled
// task (or the Startup folder) that runs this script.
//
//   - Detects agents by scanning for agent-card.json (no hardcoded list).
//   - PID lock: one supervisor per machine (blocks/logs/supervisor.pid).
//   - Restart policy: a watchdog child that dies is relaunched after a short
//     backoff (5s -> 60s), unless we're stopping.
//   - Graceful stop: SIGINT / SIGTERM stop every watchdog (which in turn stops
//     its `blocks run` child) and exit.
//
// Usage:  node scripts/supervise-all-agents.js

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

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
let delayMs = BASE_DELAY_MS
let stopping = false

const children = new Map() // name -> { child, restarts, restartTimer }

function stop(signal) {
  if (stopping) return
  stopping = true
  log(`received ${signal} — stopping all watchdogs, no restarts`)
  for (const { child, restartTimer } of children.values()) {
    clearTimeout(restartTimer)
    if (child && child.exitCode === null) child.kill('SIGTERM')
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
  const entry = { child, restarts: 0, restartTimer: null }
  children.set(name, entry)
  log(`watchdog up for "${name}" (pid ${child.pid})`)

  child.stdout.on('data', chunk => fs.appendFileSync(LOG_FILE, chunk))
  child.stderr.on('data', chunk => fs.appendFileSync(LOG_FILE, chunk))

  child.on('exit', (code, signal) => {
    log(`watchdog for "${name}" exited code=${code} signal=${signal}`)
    if (stopping) return
    if (entry.restartTimer) clearTimeout(entry.restartTimer)
    entry.restartTimer = setTimeout(() => {
      children.delete(name)
      launchWatchdog(name)
    }, delayMs)
    delayMs = Math.min(delayMs * 2, MAX_DELAY_MS)
  })
  child.on('error', err => {
    log(`watchdog spawn error for "${name}": ${err.message}`)
    if (!stopping) setTimeout(() => launchWatchdog(name), delayMs)
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
log(`blocks bin + logs: ${LOG_DIR}`)
for (const name of agents) launchWatchdog(name)
