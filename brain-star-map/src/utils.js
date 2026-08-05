export function getFirstAuthor(authors) {
  if (Array.isArray(authors)) return authors[0] || 'Unknown'
  if (typeof authors === 'string') return authors.split(',')[0] || 'Unknown'
  return 'Unknown'
}

export function generateCSV(nodes) {
  const headers = ['id', 'title', 'first_author', 'year', 'community', 'url', 'abstract']
  const rows = nodes.map(n => [
    n.id,
    `"${(n.title || '').replace(/"/g, '""')}"`,
    `"${(n.first_author || '').replace(/"/g, '""')}"`,
    n.year,
    n.community,
    n.url,
    `"${(n.abstract || '').replace(/"/g, '""')}"`
  ])
  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
}
