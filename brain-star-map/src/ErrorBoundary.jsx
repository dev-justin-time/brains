import React from 'react'

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }
  componentDidCatch(error, info) {
    console.error('ErrorBoundary:', error, info)
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          width: '100vw', height: '100vh', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: '#020205', color: '#ff6b6b',
          flexDirection: 'column', gap: 16, padding: 40
        }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>Star Map Error</h2>
          <pre style={{
            maxWidth: 600, whiteSpace: 'pre-wrap',
            background: 'rgba(255,0,0,0.05)', padding: 16, borderRadius: 8,
            fontSize: 13, color: '#ff8888'
          }}>
            {this.state.error?.toString?.() || 'Unknown error'}
          </pre>
          <button onClick={() => window.location.reload()} style={{
            padding: '10px 24px', background: '#0F52BA', color: '#fff',
            border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14
          }}>
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
