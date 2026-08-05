// Reference A2A demo agent: parses { a, b } from the request and returns { sum }.
export default async function handler(task, ctx) {
  const input = task.requestParts?.[0]
  let text = (input?.text ?? '')

  // Try to parse JSON input
  let parsed = {}
  try { parsed = JSON.parse(text) } catch { /* plain text */ }

  const a = Number(parsed.a ?? 0)
  const b = Number(parsed.b ?? 0)

  ctx?.reportStatus('Adding…')

  return {
    artifacts: [{
      data: JSON.stringify({ sum: a + b, a, b }),
      mimeType: 'application/json',
      outputId: 'sum',
    }],
  }
}
