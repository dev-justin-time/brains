// Reference A2A demo agent: echoes the request text back.
export default async function handler(task, ctx) {
  const input = task.requestParts?.[0]
  const text = (input?.text ?? '').trim()
  ctx?.reportStatus('Echoing…')
  return {
    artifacts: [{ data: `Echo: ${text}`, mimeType: 'text/plain', outputId: 'echo' }],
  }
}
