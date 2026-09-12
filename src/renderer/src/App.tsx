import { useEffect, useState } from 'react'

export default function App(): JSX.Element {
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.api.appVersion().then(setVersion)
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">llm-nai-toolbox</span>
        {version !== '' && <span className="app-version">v{version}</span>}
      </header>
    </div>
  )
}
