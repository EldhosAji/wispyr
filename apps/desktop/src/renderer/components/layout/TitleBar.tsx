import { Minus, Square, X } from 'lucide-react'
import type { ActiveProviderInfo } from '../../App'

interface TitleBarProps {
  activeProvider: ActiveProviderInfo | null
}

export function TitleBar({ activeProvider }: TitleBarProps) {
  const handleMinimize = () => window.wispyr.window.minimize()
  const handleMaximize = () => window.wispyr.window.maximize()
  const handleClose = () => window.wispyr.window.close()

  const dotClass = activeProvider
    ? activeProvider.isOnline === true
      ? 'online'
      : activeProvider.isOnline === false
        ? 'offline'
        : 'checking'
    : 'offline'

  return (
    <div className="titlebar">
      <span className="titlebar-title">Wispyr</span>

      <div className="provider-badge">
        <span className={`provider-dot ${dotClass}`} />
        <span>
          {activeProvider
            ? `${activeProvider.name} · ${activeProvider.model}`
            : 'No provider configured'}
        </span>
      </div>

      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={handleMinimize} aria-label="Minimize">
          <Minus />
        </button>
        <button className="titlebar-btn" onClick={handleMaximize} aria-label="Maximize">
          <Square />
        </button>
        <button className="titlebar-btn close" onClick={handleClose} aria-label="Close">
          <X />
        </button>
      </div>
    </div>
  )
}
