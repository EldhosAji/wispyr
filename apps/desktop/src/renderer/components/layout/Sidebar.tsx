import { Home, ListTodo, Workflow, Puzzle, Settings, Zap } from 'lucide-react'
import type { PageId } from '../../App'

interface SidebarProps {
  activePage: PageId
  onNavigate: (page: PageId) => void
}

const navItems: { id: PageId; label: string; icon: typeof Home }[] = [
  { id: 'home',      label: 'Home',      icon: Home },
  { id: 'tasks',     label: 'Tasks',     icon: ListTodo },
  { id: 'workflows', label: 'Workflows', icon: Workflow },
  { id: 'plugins',   label: 'Plugins',   icon: Puzzle },
  { id: 'settings',  label: 'Settings',  icon: Settings },
]

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <Zap size={18} color="var(--accent)" />
        <span className="sidebar-logo-text">Wispyr</span>
      </div>

      <nav className="sidebar-nav">
        <div className="sidebar-section-title">Navigation</div>
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`sidebar-item${activePage === id ? ' active' : ''}`}
            onClick={() => onNavigate(id)}
          >
            <Icon className="icon" size={16} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          v0.1.0 &middot; Phase 1
        </div>
      </div>
    </aside>
  )
}
