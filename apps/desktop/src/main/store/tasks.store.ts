import Store from 'electron-store'

export interface TaskStep {
  id: string
  title: string
  description: string
  skills: string[]
  permissionLevel: 'read_only' | 'write' | 'destructive' | 'system'
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped'
  startedAt?: string
  completedAt?: string
  result?: string
  error?: string
  log?: string
}

export interface Task {
  id: string
  description: string
  folder: string
  status: 'planning' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled'
  steps: TaskStep[]
  createdAt: string
  completedAt?: string
  error?: string
}

interface TasksSchema {
  tasks: Task[]
}

let _store: Store<TasksSchema> | null = null
function store(): Store<TasksSchema> {
  if (!_store) {
    _store = new Store<TasksSchema>({
      name: 'tasks',
      defaults: { tasks: [] },
    })
  }
  return _store
}

export function getTasks(): Task[] {
  return store().get('tasks')
}

export function addTask(task: Task): void {
  const tasks = store().get('tasks')
  tasks.unshift(task)
  store().set('tasks', tasks)
}

export function updateTask(id: string, updates: Partial<Task>): void {
  const tasks = store().get('tasks').map((t) =>
    t.id === id ? { ...t, ...updates } : t
  )
  store().set('tasks', tasks)
}

export function getTask(id: string): Task | undefined {
  return store().get('tasks').find((t) => t.id === id)
}
