import type { TaskStep } from '../store/tasks.store'
import type { ProviderConfig } from '../store/providers.store'
import { callLLM } from '../llm/call'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8)
}

interface PlannedStep {
  title: string
  action: string
  fileName?: string
  content?: string
  data?: any
  dirName?: string
  from?: string
  to?: string
  pattern?: string
  permissionLevel: 'read_only' | 'write' | 'destructive'
}

const PLAN_SYSTEM_PROMPT = `You are Wispyr's planning engine. Given a user task and working folder, output a JSON array of steps to execute.

SUPPORTED ACTIONS:

Plain text files (.txt, .md, .json, .html, .css, .js, .ts, .py, .xml, .env, .bat, .sh, .sql, .log, etc.):
- write_file: Requires: fileName, content (full text content as string)
- read_file: Requires: fileName
- append_file: Requires: fileName, content

Excel (.xlsx):
- write_file: Requires: fileName, data: { sheets: [{ name: "Sheet1", headers: ["Col1","Col2"], rows: [["val1","val2"], ...] }] }
- read_file: Requires: fileName

Word (.docx):
- write_file: Requires: fileName, data: { title: "Doc Title", content: [{ type: "heading", text: "...", level: 1 }, { type: "paragraph", text: "..." }, { type: "bullet", items: ["item1","item2"] }, { type: "table", headers: ["H1","H2"], rows: [["a","b"]] }] }
- read_file: Requires: fileName

PDF (.pdf):
- write_file: Requires: fileName, data: { title: "Title", content: [{ type: "heading", text: "...", fontSize: 18 }, { type: "paragraph", text: "..." }, { type: "list", items: ["a","b"] }, { type: "table", headers: ["H1"], rows: [["val"]] }] }
- read_file: Requires: fileName

PowerPoint (.pptx):
- write_file: Requires: fileName, data: { title: "Presentation", slides: [{ title: "Slide Title", content: "Text content", bullets: ["Point 1","Point 2"], notes: "Speaker notes" }] }

CSV (.csv):
- write_file: Requires: fileName, data: { headers: ["Col1","Col2"], rows: [["val1","val2"]] }
- read_file: Requires: fileName

ZIP (.zip):
- write_file: Requires: fileName, data: { files: [{ name: "file.txt", content: "text" }] }
- read_file: Requires: fileName

YAML (.yaml, .yml):
- write_file: Requires: fileName, data: { key: "value", nested: { a: 1 } }
- read_file: Requires: fileName

Other actions:
- list_dir: List folder contents. No params.
- create_dir: Requires: dirName
- delete_file: Requires: fileName
- move_file: Requires: from, to
- copy_file: Requires: from, to
- search_files: Requires: pattern
- organise: Sort files into category subfolders. No params.

Permission levels:
- read_only: reading, listing, searching
- write: creating, writing, moving, copying
- destructive: deleting files

RULES:
- Output ONLY a valid JSON array, no other text.
- For text files: use "content" field with FULL content (not placeholder).
- For binary files (.xlsx, .docx, .pdf, .pptx, .csv, .zip): use "data" field with the structured format shown above.
- Generate REAL, COMPLETE, USEFUL content. Not summaries or placeholders.
- For stories/essays: write at least 3-4 paragraphs.
- For spreadsheets: include realistic sample data with at least 5-10 rows.
- For presentations: include at least 3-5 slides with real content.
- Keep plans simple: 1-4 steps max.
- After creating a file, add a read_file step to verify.

EXAMPLE for text:
[{"title":"Create story","action":"write_file","fileName":"story.txt","content":"Once upon a time...\\n\\nThe robot walked...\\n","permissionLevel":"write"},{"title":"Verify","action":"read_file","fileName":"story.txt","permissionLevel":"read_only"}]

EXAMPLE for Excel:
[{"title":"Create spreadsheet","action":"write_file","fileName":"budget.xlsx","data":{"sheets":[{"name":"Budget","headers":["Item","Category","Amount"],"rows":[["Rent","Housing","1500"],["Groceries","Food","400"],["Gas","Transport","150"]]}]},"permissionLevel":"write"}]

EXAMPLE for Word:
[{"title":"Create report","action":"write_file","fileName":"report.docx","data":{"title":"Monthly Report","content":[{"type":"heading","text":"Summary","level":1},{"type":"paragraph","text":"This month we achieved..."},{"type":"bullet","items":["Revenue up 15%","New clients: 12"]}]},"permissionLevel":"write"}]`

/**
 * Use the LLM to generate a plan for the task.
 * Falls back to regex-based parsing if LLM fails.
 */
export async function planTask(
  task: string,
  folder: string,
  provider: ProviderConfig | null,
  onProgress?: (msg: string) => void,
): Promise<TaskStep[]> {
  // If no provider, use fallback
  if (!provider) {
    onProgress?.('No LLM provider configured — using built-in parser')
    return fallbackParse(task)
  }

  onProgress?.(`Planning with ${provider.name} (${provider.model})...`)

  try {
    const response = await callLLM(provider, [
      { role: 'system', content: PLAN_SYSTEM_PROMPT },
      { role: 'user', content: `Task: "${task}"\nWorking folder: ${folder}\n\nGenerate the execution plan as a JSON array:` },
    ])

    if (response.error) {
      onProgress?.(`LLM error: ${response.error} — falling back to built-in parser`)
      return fallbackParse(task)
    }

    // Parse the LLM response
    const steps = parseLLMPlan(response.content)
    if (steps.length > 0) {
      onProgress?.(`Plan generated: ${steps.length} steps`)
      return steps
    }

    onProgress?.('LLM returned invalid plan — falling back to built-in parser')
    return fallbackParse(task)
  } catch (err: any) {
    onProgress?.(`LLM call failed: ${err.message} — falling back`)
    return fallbackParse(task)
  }
}

function parseLLMPlan(raw: string): TaskStep[] {
  // Extract JSON array from the response (LLM might wrap it in markdown code blocks)
  let jsonStr = raw.trim()

  // Strip markdown code block if present
  const codeBlock = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlock) jsonStr = codeBlock[1].trim()

  // Find the JSON array
  const arrayStart = jsonStr.indexOf('[')
  const arrayEnd = jsonStr.lastIndexOf(']')
  if (arrayStart === -1 || arrayEnd === -1) return []
  jsonStr = jsonStr.substring(arrayStart, arrayEnd + 1)

  try {
    const planned: PlannedStep[] = JSON.parse(jsonStr)
    if (!Array.isArray(planned) || planned.length === 0) return []

    return planned.map((p) => ({
      id: generateId(),
      title: p.title || 'Execute step',
      description: describeAction(p),
      skills: [`filesystem.${p.action}`],
      permissionLevel: p.permissionLevel || 'write',
      status: 'pending' as const,
      result: JSON.stringify({
        action: p.action,
        fileName: p.fileName,
        content: p.content,
        data: p.data,
        dirName: p.dirName,
        from: p.from,
        to: p.to,
        pattern: p.pattern,
      }),
    }))
  } catch {
    return []
  }
}

function describeAction(step: PlannedStep): string {
  switch (step.action) {
    case 'write_file': return `Write "${step.fileName}" (${step.content?.length || 0} chars)`
    case 'read_file': return `Read "${step.fileName}"`
    case 'list_dir': return 'List folder contents'
    case 'create_dir': return `Create directory "${step.dirName}"`
    case 'delete_file': return `Delete "${step.fileName}"`
    case 'move_file': return `Move "${step.from}" → "${step.to}"`
    case 'copy_file': return `Copy "${step.from}" → "${step.to}"`
    case 'search_files': return `Search for "${step.pattern}"`
    case 'organise': return 'Organise files into categories'
    case 'append_file': return `Append to "${step.fileName}"`
    default: return step.title || step.action
  }
}

// ─── Fallback: regex-based parser (no LLM needed) ───

const FILE_EXTENSIONS = ['txt', 'text', 'md', 'json', 'csv', 'html', 'css', 'js', 'ts', 'py', 'xml', 'yaml', 'yml', 'log', 'bat', 'sh', 'ps1', 'sql', 'env', 'jsx', 'tsx']

function fallbackParse(task: string): TaskStep[] {
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

  const explicitFile = task.match(/[""]?([a-zA-Z0-9_\-]+\.[a-zA-Z0-9]{1,5})[""]?/)
  const lastWord = words[words.length - 1]
  const hasExtWord = FILE_EXTENSIONS.includes(lastWord)

  // ─── Create file ───
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

  // Last resort: file extension at end of input
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
