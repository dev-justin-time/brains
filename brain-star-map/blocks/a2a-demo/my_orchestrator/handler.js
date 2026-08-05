// Reference A2A demo agent (from the Blocks "Set Up A2A Communication" guide):
// receives a task, calls two specialists in parallel via ctx.taskClient, merges
// their results, and returns a single artifact to the caller.
import { executeSubTask } from '../../lib/a2a.js'

// Client-side timeout must stay below this card's maxRunningTimeSec (60s) with
// room for result assembly — the guide uses 30s.
const SUB_TASK_TIMEOUT_MS = 30_000

export default async function handler(task, ctx) {
  ctx?.reportStatus('Dispatching sub-tasks...')

  // Call two agents in parallel using ctx.taskClient (already authenticated).
  // Omit ownerId — it defaults to the API key's authenticated identity.
  const [echoResult, adderResult] = await Promise.all([
    executeSubTask(ctx.taskClient, 'my_echo', [{ partId: 'request', text: 'Hello!' }], { timeoutMs: SUB_TASK_TIMEOUT_MS }),
    executeSubTask(ctx.taskClient, 'my_adder', [{ partId: 'request', text: JSON.stringify({ kind: 'math_add', a: 3, b: 4 }) }], { timeoutMs: SUB_TASK_TIMEOUT_MS }),
  ])

  ctx?.reportStatus('Compiling results...')

  return {
    artifacts: [{
      data: JSON.stringify({
        echo: echoResult,
        adder: adderResult,
        summary: `Echo: ${echoResult.status}, Adder: ${adderResult.status}`,
      }, null, 2),
      mimeType: 'application/json',
      outputId: 'merged',
    }],
  }
}
