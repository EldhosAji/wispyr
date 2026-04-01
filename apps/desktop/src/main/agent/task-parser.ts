/**
 * Task Parser — fallback plan generation for when the agent engine
 * cannot be used (no provider, offline mode, etc.)
 *
 * Also provides the legacy planTask() function for backward compatibility.
 */
import type { TaskStep } from '../store/tasks.store'
import type { ProviderConfig } from '../store/providers.store'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8)
}

/**
 * Legacy plan generation — used as fallback when agent engine is not available.
 * Parses natural language into filesystem actions using regex.
 */
export function fallbackParse(task: string): TaskStep[] {
  const lower = task.toLowerCase().trim()
  const words = lower.split(/\s+/)

  const hasCreate = /\b(create|make|write|generate|add|new|touch)\b/.test(lower)
  const hasDelete = /\b(delete|remove|rm|erase)\b/.test(lower)
  const hasRead = /\b(read|show|display|cat|view|open|print)\b/.test(lower)
  const hasMove = /\b(move|rename|mv)\b/.test(lower)
  const hasCopy = /\b(copy|duplicate|clone|cp)\b/.test(lower)
  const hasSearch = /\b(search|find|look\s*for|grep)\b/.test(lower)
  const hasOrganise = /\b(organis|organiz|sort|clean\s*up|tidy)\b/.test(lower)
  const hasList = /\b(list|ls|dir|what.s\s+in)\b/.test(lower)
  const hasFolder = /\b(folder|directory|dir)\b/.test(lower)

  const FILE_EXTENSIONS = ['txt', 'text', 'md', 'json', 'csv', 'html', 'css', 'js', 'ts', 'py', 'xml', 'yaml', 'yml', 'log', 'bat', 'sh', 'ps1', 'sql', 'env', 'jsx', 'tsx']

  const explicitFile = task.match(/[""]?([a-zA-Z0-9_\-]+\.[a-zA-Z0-9]{1,5})[""]?/)
  const lastWord = words[words.length - 1]
  const hasExtWord = FILE_EXTENSIONS.includes(lastWord)

  if (hasCreate && !hasFolder) {
    let fileName: string
    if (explicitFile) {
      fileName = explicitFile[1]
    } else if (hasExtWord) {
      const verbIdx = words.findIndex(w => /^(create|make|write|generate|add|new|touch)$/.test(w))
      const nameWords = words.slice(verbIdx + 1, -1).filter(w => !['a', 'an', 'the', 'new', 'file', 'called', 'named'].includes(w))
      fileName = (nameWords.length > 0 ? nameWords.join('_') : 'untitled') + '.' + lastWord
    } else {
      fileName = 'output.txt'
    }
    const content = extractContent(task, fileName)
    return [
      { id: generateId(), title: `Create: ${fileName}`, description: `Write "${fileName}"`, skills: ['filesystem.write_file'], permissionLevel: 'write', status: 'pending', result: JSON.stringify({ action: 'write_file', fileName, content }) },
      { id: generateId(), title: `Verify: ${fileName}`, description: `Read back the file`, skills: ['filesystem.read_file'], permissionLevel: 'read_only', status: 'pending', result: JSON.stringify({ action: 'read_file', fileName }) },
    ]
  }

  if (hasCreate && hasFolder) {
    const nameMatch = task.match(/(?:folder|directory|dir)\s+(?:called\s+|named\s+)?[""]?([a-zA-Z0-9_\-\s]+)[""]?/i)
    const dirName = nameMatch ? nameMatch[1].trim().replace(/\s+/g, '_') : 'new_folder'
    return [
      { id: generateId(), title: `Create folder: ${dirName}`, description: `Create "${dirName}"`, skills: ['filesystem.create_dir'], permissionLevel: 'write', status: 'pending', result: JSON.stringify({ action: 'create_dir', dirName }) },
    ]
  }

  if (hasDelete && explicitFile) {
    return [
      { id: generateId(), title: `Delete: ${explicitFile[1]}`, description: `Permanently delete`, skills: ['filesystem.delete_file'], permissionLevel: 'destructive', status: 'pending', result: JSON.stringify({ action: 'delete_file', fileName: explicitFile[1] }) },
    ]
  }

  if (hasRead && explicitFile) {
    return [
      { id: generateId(), title: `Read: ${explicitFile[1]}`, description: `Display contents`, skills: ['filesystem.read_file'], permissionLevel: 'read_only', status: 'pending', result: JSON.stringify({ action: 'read_file', fileName: explicitFile[1] }) },
    ]
  }

  if (hasSearch) {
    const searchMatch = task.match(/(?:search|find|look\s*for|grep)\s+(?:for\s+)?[""]?(.+?)[""]?\s*$/i)
    return [
      { id: generateId(), title: `Search: "${searchMatch?.[1] || task}"`, description: `Find matching files`, skills: ['filesystem.search_files'], permissionLevel: 'read_only', status: 'pending', result: JSON.stringify({ action: 'search_files', pattern: searchMatch?.[1] || task }) },
    ]
  }

  if (hasOrganise) {
    return [
      { id: generateId(), title: 'Scan folder', description: 'List files', skills: ['filesystem.list_dir'], permissionLevel: 'read_only', status: 'pending', result: JSON.stringify({ action: 'list_dir' }) },
      { id: generateId(), title: 'Organise files', description: 'Sort into categories', skills: ['filesystem.organise'], permissionLevel: 'write', status: 'pending', result: JSON.stringify({ action: 'organise' }) },
    ]
  }

  if (hasList) {
    return [
      { id: generateId(), title: 'List folder', description: 'Scan contents', skills: ['filesystem.list_dir'], permissionLevel: 'read_only', status: 'pending', result: JSON.stringify({ action: 'list_dir' }) },
    ]
  }

  if (hasExtWord) {
    const nameWords = words.slice(0, -1).filter(w => !['a', 'an', 'the', 'please', 'can', 'you'].includes(w))
    const name = nameWords.length > 0 ? nameWords.join('_') : 'output'
    const fileName = `${name}.${lastWord}`
    return [
      { id: generateId(), title: `Create: ${fileName}`, description: `Write "${fileName}"`, skills: ['filesystem.write_file'], permissionLevel: 'write', status: 'pending', result: JSON.stringify({ action: 'write_file', fileName, content: extractContent(task, fileName) }) },
      { id: generateId(), title: `Verify: ${fileName}`, description: `Read back`, skills: ['filesystem.read_file'], permissionLevel: 'read_only', status: 'pending', result: JSON.stringify({ action: 'read_file', fileName }) },
    ]
  }

  return [
    { id: generateId(), title: 'List folder', description: 'Scan contents', skills: ['filesystem.list_dir'], permissionLevel: 'read_only', status: 'pending', result: JSON.stringify({ action: 'list_dir' }) },
  ]
}

function extractContent(task: string, fileName: string): string {
  const lower = task.toLowerCase()
  const contentMatch = task.match(/(?:with\s+(?:the\s+)?(?:content|text)|containing|that\s+(?:says|contains)|saying|content[:\s]+)\s*[""]?(.+?)[""]?\s*$/i)
  if (contentMatch) return contentMatch[1]

  if (lower.includes('hello world')) return 'Hello, World!\n'
  if (lower.includes('hello')) return 'Hello!\n'
  if (lower.includes('todo')) return '# TODO\n\n- [ ] Item 1\n- [ ] Item 2\n- [ ] Item 3\n'
  if (lower.includes('readme')) return `# Project\n\nDescription goes here.\n`

  if (fileName.endsWith('.json')) return '{\n  \n}\n'
  if (fileName.endsWith('.html')) return '<!DOCTYPE html>\n<html>\n<head><title>Document</title></head>\n<body>\n  <h1>Hello, World!</h1>\n</body>\n</html>\n'
  if (fileName.endsWith('.py')) return '#!/usr/bin/env python3\n\ndef main():\n    print("Hello, World!")\n\nif __name__ == "__main__":\n    main()\n'
  if (fileName.endsWith('.js') || fileName.endsWith('.ts')) return 'console.log("Hello, World!");\n'
  if (fileName.endsWith('.md')) return `# ${fileName.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ')}\n\n`
  if (fileName.endsWith('.bat')) return '@echo off\necho Hello, World!\npause\n'
  if (fileName.endsWith('.sh')) return '#!/bin/bash\necho "Hello, World!"\n'

  return `${fileName.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ')}\n`
}
