import { Zap, Circle } from 'lucide-react'
import type { ActiveProviderInfo } from '../../App'

interface StatusBarProps {
  agentStatus: string
  activeProvider: ActiveProviderInfo | null
}

const statusLabels: Record<string, string> = {
  idle: 'Ready',
  planning: 'Planning...',
  awaiting_approval: 'Awaiting approval',
  running: 'Running task...',
  completed: 'Task completed',
  failed: 'Task failed',
  cancelled: 'Task cancelled',
}

export function StatusBar({ agentStatus, activeProvider }: StatusBarProps) {
  return (
    <div className="statusbar">
      <div className="statusbar-item">
        <Zap size={10} />
        <span>Wispyr v0.1.0</span>
      </div>
      <div className="statusbar-item">
        <Circle
          size={6}
          fill={agentStatus === 'running' ? 'var(--success)' : agentStatus === 'idle' ? '#fff' : 'var(--warning)'}
          stroke="none"
        />
        <span>{statusLabels[agentStatus] || agentStatus}</span>
      </div>
      <div className="statusbar-item" style={{ marginLeft: 'auto' }}>
        <span>
          {activeProvider
            ? `${activeProvider.type}: ${activeProvider.model}`
            : 'No provider'}
        </span>
      </div>
    </div>
  )
}
