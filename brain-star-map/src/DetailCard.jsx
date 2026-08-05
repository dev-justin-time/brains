import React from 'react'

export default function DetailCard({ node, onClose }) {
  if (!node) return null
  return (
    <div className="detail-card">
      <button className="close-btn" onClick={onClose}>×</button>
      <h2>{node.title}</h2>
      <div className="detail-meta">
        {node.first_author} et al. • {node.year} • {node.community_label || `Cluster ${node.community}`}
      </div>
      <div className="detail-abstract">{node.abstract}</div>
      <a className="detail-link" href={node.url} target="_blank" rel="noreferrer">
        Open paper ↗
      </a>
    </div>
  )
}
