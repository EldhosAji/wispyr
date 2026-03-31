import { useState, useEffect, useCallback } from 'react'
import { TitleBar } from './components/layout/TitleBar'
import { Sidebar } from './components/layout/Sidebar'
import { StatusBar } from './components/layout/StatusBar'
import { Home } from './pages/Home'
import { Tasks } from './pages/Tasks'
import { Workflows } from './pages/Workflows'
import { Plugins } from './pages/Plugins'
import { Settings } from './pages/Settings'

export type PageId = 'home' | 'tasks' | 'workflows' | 'plugins' | 'settings'

export interface ActiveProviderInfo {
  name: string
  model: string
  type: string
  isOnline: boolean | null
}

export function App() {
  const [activePage, setActivePage] = useState<PageId>('home')
  const [activeProvider, setActiveProvider] = useState<ActiveProviderInfo | null>(null)
  const [agentStatus, setAgentStatus] = useState<string>('idle')
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null)

  const refreshProvider = useCallback(async () => {
    try {
      const p = await window.wispyr.providers.getActive()
      if (p) {
        setActiveProvider({ name: p.name, model: p.model, type: p.type, isOnline: null })
        // Test connection
        const result = await window.wispyr.providers.test(p.id)
        setActiveProvider({ name: p.name, model: p.model, type: p.type, isOnline: result.success })
      } else {
        setActiveProvider(null)
      }
    } catch {
      setActiveProvider(null)
    }
  }, [])

  useEffect(() => {
    refreshProvider()

    const unsubStatus = window.wispyr.agent.onStatus((data: any) => {
      setAgentStatus(data.status)
      setCurrentTaskId(data.taskId)
    })

    return () => { unsubStatus() }
  }, [refreshProvider])

  return (
    <div className="app-window">
      <TitleBar activeProvider={activeProvider} />
      <Sidebar activePage={activePage} onNavigate={setActivePage} />
      <main className="content">
        {activePage === 'home' && <Home agentStatus={agentStatus} currentTaskId={currentTaskId} />}
        {activePage === 'tasks' && <Tasks />}
        {activePage === 'workflows' && <Workflows />}
        {activePage === 'plugins' && <Plugins />}
        {activePage === 'settings' && <Settings onProviderChange={refreshProvider} />}
      </main>
      <StatusBar agentStatus={agentStatus} activeProvider={activeProvider} />
    </div>
  )
}
