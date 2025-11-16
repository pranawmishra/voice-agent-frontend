import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './components/App'
import './styles/globals.css'
import { stsConfig } from './lib/constants' // Keep as fallback
import { VoiceBotProvider } from './context/VoiceBotContextProvider'
import { MicrophoneContextProvider } from './context/MicrophoneContextProvider'
import { DeepgramContextProvider } from './context/DeepgramContextProvider'
import { apiService } from './services/api'
import type { StsConfig } from './utils/deepgramUtils'

const AppWrapper = () => {
  const [config, setConfig] = useState<StsConfig>(stsConfig) // Use fallback initially
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const backendConfig = await apiService.getDeepgramConfig()
        setConfig(backendConfig)
        setError(null)
      } catch (err) {
        console.warn('Failed to fetch backend config, using fallback:', err)
        setError(err instanceof Error ? err.message : 'Failed to fetch config')
      } finally {
        setLoading(false)
      }
    }

    fetchConfig()
  }, [])

  if (loading)
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        fontFamily: 'system-ui, sans-serif'
      }}>
        Loading configuration...
      </div>
    )

  return (
    <DeepgramContextProvider>
      <MicrophoneContextProvider>
        <VoiceBotProvider>
          <App defaultStsConfig={config} />
          {error && (
            <div style={{
              position: 'fixed',
              top: '10px',
              right: '10px',
              background: '#ff6b6b',
              color: 'white',
              padding: '8px 12px',
              borderRadius: '4px',
              fontSize: '12px',
              zIndex: 1000
            }}>
              Using fallback config: {error}
            </div>
          )}
        </VoiceBotProvider>
      </MicrophoneContextProvider>
    </DeepgramContextProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  // <React.StrictMode>
    <AppWrapper />
  // </React.StrictMode>
)
