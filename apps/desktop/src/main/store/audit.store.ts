import Store from 'electron-store'

export interface AuditEntry {
  id: number
  timestamp: string
  taskId?: string
  skill: string
  action: string
  params: string
  result?: string
  permission: string
  userNote?: string
}

export interface AuditFilter {
  dateFrom?: string
  dateTo?: string
  skill?: string
  decision?: string
  search?: string
}

interface AuditSchema {
  entries: AuditEntry[]
  nextId: number
}

let _store: Store<AuditSchema> | null = null
function store(): Store<AuditSchema> {
  if (!_store) {
    _store = new Store<AuditSchema>({
      name: 'audit',
      defaults: { entries: [], nextId: 1 },
    })
  }
  return _store
}

export function appendAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
  const entries = store().get('entries')
  const nextId = store().get('nextId')
  const newEntry: AuditEntry = {
    ...entry,
    id: nextId,
    timestamp: new Date().toISOString(),
  }
  entries.push(newEntry)
  store().set('entries', entries)
  store().set('nextId', nextId + 1)
  return newEntry
}

export function getAuditEntries(filter?: AuditFilter): AuditEntry[] {
  let entries = store().get('entries')

  if (filter) {
    if (filter.dateFrom) {
      entries = entries.filter((e) => e.timestamp >= filter.dateFrom!)
    }
    if (filter.dateTo) {
      entries = entries.filter((e) => e.timestamp <= filter.dateTo!)
    }
    if (filter.skill) {
      entries = entries.filter((e) => e.skill === filter.skill)
    }
    if (filter.decision) {
      entries = entries.filter((e) => e.permission === filter.decision)
    }
    if (filter.search) {
      const s = filter.search.toLowerCase()
      entries = entries.filter(
        (e) =>
          e.action.toLowerCase().includes(s) ||
          e.params.toLowerCase().includes(s) ||
          e.skill.toLowerCase().includes(s)
      )
    }
  }

  return entries.reverse()
}

export function exportAudit(format: 'csv' | 'json'): string {
  const entries = store().get('entries')
  if (format === 'json') {
    return JSON.stringify(entries, null, 2)
  }
  const headers = 'id,timestamp,taskId,skill,action,params,result,permission,userNote'
  const rows = entries.map(
    (e) =>
      `${e.id},"${e.timestamp}","${e.taskId || ''}","${e.skill}","${e.action}","${e.params.replace(/"/g, '""')}","${(e.result || '').replace(/"/g, '""')}","${e.permission}","${e.userNote || ''}"`
  )
  return [headers, ...rows].join('\n')
}
