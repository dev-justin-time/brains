import React, { useCallback } from 'react'
import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import { generateCSV } from './utils'

export default function DownloadButton({ nodes }) {
  const handleClick = useCallback(async () => {
    const zip = new JSZip()
    zip.file('corpus.csv', generateCSV(nodes))
    zip.file('README.txt', `Brain Tech Citation Star Map Corpus
Generated: ${new Date().toISOString()}
Papers: ${nodes.length}
Source: arXiv API
`)
    const blob = await zip.generateAsync({ type: 'blob' })
    saveAs(blob, 'brain_tech_corpus.zip')
  }, [nodes])

  return (
    <button className="download-btn" onClick={handleClick}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      Download Corpus (ZIP)
    </button>
  )
}
