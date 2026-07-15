'use client'

import { useEffect } from 'react'

export default function Home() {
  useEffect(() => {
    window.location.replace('/slate/index.html')
  }, [])

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      fontFamily: 'system-ui, sans-serif',
      color: '#888',
    }}>
      Loading Slate…
    </div>
  )
}
