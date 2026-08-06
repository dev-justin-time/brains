import React, { useState, useEffect, useCallback, useMemo } from 'react'
import Graph from './Graph'
import Legend from './Legend'
import DetailCard from './DetailCard'
import DownloadButton from './DownloadButton'
import ChatPanel from './ChatPanel'

export default function App() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedNode, setSelectedNode] = useState(null)
  const [highlightComm, setHighlightComm] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetch('./graph_data.json')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(d => {
        if (cancelled) return
        // Validate structure
        if (!d.nodes || !Array.isArray(d.nodes) || !d.links || !Array.isArray(d.links)) {
          throw new Error('Invalid graph_data.json structure')
        }
        setData(d)
        setLoading(false)
      })
      .catch(e => {
        if (cancelled) return
        console.error('Failed to load graph data:', e)
        setError(e.message)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const handleNodeClick = useCallback((node) => {
    setSelectedNode(prev => prev === node.id ? null : node.id)
  }, [])

  const handleLegendHover = useCallback((commId) => {
    setHighlightComm(commId)
  }, [])

  const handleLegendClick = useCallback((commId) => {
    setHighlightComm(prev => prev === commId ? null : commId)
  }, [])

  const handleCloseDetail = useCallback(() => {
    setSelectedNode(null)
  }, [])

  const selectedNodeData = useMemo(() => {
    if (!data || !selectedNode) return null
    return data.nodes.find(n => n.id === selectedNode) || null
  }, [data, selectedNode])

  const commColors = useMemo(() => {
    if (!data) return {}
    const map = {}
    data.nodes.forEach(n => {
      if (!map[n.community]) map[n.community] = n.color
    })
    return map
  }, [data])

  const commCounts = useMemo(() => {
    if (!data) return {}
    const map = {}
    data.nodes.forEach(n => {
      map[n.community] = (map[n.community] || 0) + 1
    })
    return map
  }, [data])

  // Loading state
  if (loading) {
    return (
      <div className="loading-overlay">
        <div>Loading star map…</div>
      </div>
    )
  }

  // Error state
  if (error || !data) {
    return (
      <div style={{
        width: '100vw', height: '100vh', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: '#020205', color: '#ff6b6b',
        flexDirection: 'column', gap: 16, padding: 40
      }}>
        <div>Failed to load: {error || 'Unknown error'}</div>
        <button onClick={() => window.location.reload()} style={{
          padding: '10px 24px', background: '#0F52BA', color: '#fff',
          border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14
        }}>
          Reload
        </button>
      </div>
    )
  }

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', overflow: 'hidden', background: '#020205' }}>
      <Graph
        data={data}
        onNodeClick={handleNodeClick}
        highlightComm={highlightComm}
        selectedNode={selectedNode}
      />
      <div className="ui-layer">
        <div className="header-banner">
          <h1>Brain Citation Star Map</h1>
          <p>
            {data.meta.total_papers} papers · {data.meta.total_edges} edges ·{' '}
            {Object.keys(data.meta.communities).length} communities · arXiv {data.meta.generated_at}
          </p>
        </div>
        <Legend
          communities={data.meta.communities}
          counts={commCounts}
          activeComm={highlightComm}
          onHover={handleLegendHover}
          onClick={handleLegendClick}
          commColors={commColors}
        />
        <DetailCard node={selectedNodeData} onClose={handleCloseDetail} />
        <DownloadButton nodes={data.nodes} />
        <ChatPanel totalPapers={data.nodes.length} />
        <a className="demo-link" href="demo.html" title="Open the standalone demo page (same visualization, no chat panel)">
          Demo page ↗
        </a>
        <div className="meta-badge">
          <div>
            {data.meta.total_papers} papers • {data.meta.total_edges} edges •{' '}
            {Object.keys(data.meta.communities).length} communities
          </div>
          <div style={{ opacity: 0.6, marginTop: 3 }}>
            {data.meta.data_completeness?.note || ''}
          </div>
        </div>
      </div>
    </div>
  )
}
