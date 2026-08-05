import React from 'react'

export default function Legend({ communities, activeComm, onHover, onClick, commColors }) {
  return (
    <div className="legend">
      <h3>Communities</h3>
      {Object.entries(communities).map(([id, label]) => {
        const color = commColors?.[id] || '#888'
        return (
          <div
            key={id}
            className={`comm-row ${activeComm === Number(id) ? 'active' : ''}`}
            onMouseEnter={() => onHover(Number(id))}
            onMouseLeave={() => onHover(null)}
            onClick={() => onClick(Number(id))}
          >
            <span className="comm-dot" style={{ background: color, color: color }} />
            <span>{label}</span>
          </div>
        )
      })}
    </div>
  )
}
