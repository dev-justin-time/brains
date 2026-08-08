// Restart the Blocks agent network without touching unrelated processes.
//
// The supervisor owns one watchdog per agent, and each watchdog owns one
// `blocks run` child. This script uses only the PID markers written under
// blocks/logs/; it never kills by image name (for example, `taskkill
// /IM node.exe` would be unsafe on a development machine).
//
// Usage:
//   npm run blocks:restart
//   npm run blocks:restart -- --dry-run
//   node scripts/restart-agents.js --help

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const LOG_DIR = path.join(ROOT, 'blocks', 'logs')
const SUPERVISOR = path.join(__dirname, 'supervise-all-agents.js')
const START_VBS = path.join(__dirname, 'start-supervisor.vbs')
const isWindows = process.platform === 'win32'

const args = new Set(process.argv.slice(2))
if (args.has('--help') || args.has('-h')) {
  console.log(`Restart the project Blocks agent network.\n\nUsage:\n  npm run blocks:restart              Stop and relaunch the supervisor tree\n  npm run blocks:restart -- --dry-run Inspect recorded PIDs without stopping anything\n  node scripts/restart-agents.js --help\n\nOnly PIDs recorded in blocks/logs/*.pid are considered. The script verifies\nthat recorded processes look like Node/Blocks processes before terminating them.`)
  process.exit(0)
}

const dryRun = args.has('--dry-run')
const unexpected = [...args].filter(arg => !['--dry-run', '--help', '-h'].includes(arg))
if (unexpected.length) {
  console.error(`Unknown option(s): ${unexpected.join(', ')}`)
  console.error('Use --help for usage.')
  process.exit(2)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = message => console.log(`[restart] ${message}`)

function pidFromFile(file) {
  try {
    const value = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function pidFiles() {
  if (!fs.existsSync(LOG_DIR)) return []
  return fs.readdirSync(LOG_DIR)
    .filter(name => name === 'supervisor.pid' || name.endsWith('.watchdog.pid') || name.endsWith('.child.pid'))
    .map(name => path.join(LOG_DIR, name))
}

function kindFor(file) {
  if (file.endsWith('.child.pid')) return 'child'
  if (file.endsWith('.watchdog.pid')) return 'watchdog'
  return 'supervisor'
}

function normalize(value) {
  return String(value || '').replaceAll('\\\\', '/').toLowerCase()
}

function projectCommand(value) {
  const command = normalize(value)
  const root = normalize(ROOT)
  return command.includes(root) && (
    command.includes('supervise-all-agents.js') ||
    command.includes('watch-blocks-agent.js')
  )
}

function windowsCommandLine(pid) {
  // WMIC is present on many Windows installations; PowerShell/CIM is the
  // fallback on newer installations where WMIC has been removed. Both calls
  // return only process metadata and never include environment variables.
  const wmic = spawnSync('wmic.exe', [
    'process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine,ExecutablePath', '/format:list'
  ], { encoding: 'utf8', windowsHide: true })
  if (!wmic.error && wmic.status === 0 && wmic.stdout) {
    const fields = Object.fromEntries(String(wmic.stdout).split(/\r?\n/)
      .map(line => line.match(/^([^=]+)=(.*)$/))
      .filter(Boolean)
      .map(match => [match[1], match[2]]))
    if (fields.CommandLine || fields.ExecutablePath) return fields
  }

  const ps = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\") | ForEach-Object { \"$($_.ExecutablePath)|$($_.CommandLine)\" }`
  ], { encoding: 'utf8', windowsHide: true })
  if (!ps.error && ps.status === 0 && ps.stdout) {
    const [executablePath, ...commandParts] = String(ps.stdout).trim().split('|')
    if (executablePath || commandParts.length) {
      return { ExecutablePath: executablePath, CommandLine: commandParts.join('|') }
    }
  }
  return null
}

// Return a small, non-secret process description. A recorded Node PID must
// also point back to this checkout; image-name checks alone are unsafe after
// an OS PID has been reused by another Node process.
function processInfo(pid) {
  if (isWindows) {
    const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (result.error || result.status !== 0) return null
    const line = String(result.stdout || '').trim().split(/\r?\n/).find(Boolean)
    if (!line || /^INFO:/i.test(line)) return null
    const image = line.split(',')[0]?.replace(/^"|"$/g, '') || ''
    if (!/^(node|blocks)(\.exe)?$/i.test(image)) return { image, allowed: false, identityVerified: true }
    const details = windowsCommandLine(pid)
    if (!details) return { image, allowed: false, identityVerified: false }
    const executable = details.ExecutablePath || ''
    const command = details.CommandLine || ''
    const isBlocks = /^blocks(\.exe)?$/i.test(image)
    const allowed = isBlocks
      ? /(^|[\\/])blocks(\.exe)?$/i.test(executable || image)
      : projectCommand(command)
    return { image, command, allowed, identityVerified: true }
  }

  const result = spawnSync('ps', ['-p', String(pid), '-o', 'comm=,args='], { encoding: 'utf8' })
  if (result.error || result.status !== 0) return null
  const line = String(result.stdout || '').trim()
  if (!line) return null
  const image = line.split(/\s+/)[0]
  const command = line.slice(image.length).trim()
  const isBlocks = /(^|[\\/])(node|blocks)(\\.exe)?$/i.test(image)
  return { image, command, allowed: isBlocks && (/blocks(\.exe)?$/i.test(image) || projectCommand(command)), identityVerified: true }
}

function pidAlive(pid) {
  if (isWindows) {
    const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    })
    return !result.error && result.status === 0 && !/^INFO:/im.test(String(result.stdout || '').trim())
  }
  try { process.kill(pid, 0); return true } catch { return false }
}

function recordedProcesses() {
  const seen = new Set()
  const records = []
  for (const file of pidFiles()) {
    const pid = pidFromFile(file)
    if (!pid || pid === process.pid || seen.has(pid)) continue
    seen.add(pid)
    records.push({ file, pid, kind: kindFor(file), info: processInfo(pid) })
  }
  return records
}

function terminate(pid) {
  if (isWindows) {
    // A watchdog's blocks.exe child must be terminated with its parent tree;
    // plain Node SIGTERM can orphan the native Blocks process on Windows.
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'ignore',
    })
    return !result.error && (result.status === 0 || result.status === 128)
  }

  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

function cleanDeadPidFiles() {
  for (const file of pidFiles()) {
    const pid = pidFromFile(file)
    if (!pid || !pidAlive(pid)) {
      try {
        fs.unlinkSync(file)
        log(`removed stale ${path.basename(file)}`)
      } catch { /* another process may have cleaned it */ }
    }
  }
}

async function waitForPidsToStop(records, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const alive = records.filter(record => pidAlive(record.pid))
    if (!alive.length) return true
    await sleep(250)
  }
  return records.every(record => !pidAlive(record.pid))
}

async function waitForSupervisor(timeoutMs = 10_000) {
  const file = path.join(LOG_DIR, 'supervisor.pid')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pid = pidFromFile(file)
    if (pid && processInfo(pid)?.allowed) return pid
    await sleep(250)
  }
  return null
}

async function launchSupervisor() {
  if (isWindows && fs.existsSync(START_VBS)) {
    // Reuse the project's hidden, detached launcher on Windows. It points at
    // the configured Node installation and survives the launching shell.
    const child = spawn('wscript.exe', [START_VBS], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('spawn', resolve)
    })
    return
  }

  const child = spawn(process.execPath, [SUPERVISOR], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', resolve)
  })
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const records = recordedProcesses()

  if (!records.length) {
    log('no project PID markers found; starting the supervisor')
  }

  const unsafe = records.filter(record => record.info && !record.info.allowed)
  if (unsafe.length) {
    for (const record of unsafe) {
      console.error(`[restart] refusing PID ${record.pid} from ${path.basename(record.file)} (image: ${record.info.image})`)
    }
    console.error('[restart] no processes were stopped; inspect the PID markers before retrying')
    process.exit(1)
  }

  for (const record of records) {
    log(`${record.kind} PID ${record.pid}: ${record.info ? `live (${record.info.image})` : 'not running'}`)
  }

  if (dryRun) {
    log('dry run complete; no processes or PID files changed')
    return
  }

  // Stop the supervisor first so it cannot respawn watchdogs while the rest
  // of the tree is being shut down. On Windows its process-tree kill also
  // takes down descendants; the later entries are harmless no-ops.
  const order = { supervisor: 0, watchdog: 1, child: 2 }
  for (const record of records.sort((a, b) => order[a.kind] - order[b.kind])) {
    if (!record.info) continue
    log(`stopping ${record.kind} PID ${record.pid}`)
    if (!terminate(record.pid)) log(`PID ${record.pid} was already stopped or could not be terminated`)
  }

  if (!(await waitForPidsToStop(records))) {
    console.error('[restart] one or more recorded processes did not stop; refusing to start a duplicate supervisor')
    process.exit(1)
  }
  cleanDeadPidFiles()
  log('starting detached supervisor')
  await launchSupervisor()

  const supervisorPid = await waitForSupervisor()
  if (!supervisorPid) {
    console.error('[restart] supervisor did not create a verified live PID marker')
    process.exit(1)
  }
  log(`supervisor restarted (PID ${supervisorPid}); watchdogs will come online shortly`)
}

main().catch(error => {
  console.error(`[restart] ${error.message}`)
  process.exit(1)
})
