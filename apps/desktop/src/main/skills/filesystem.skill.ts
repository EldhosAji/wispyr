import { readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, unlinkSync, readdirSync, statSync, existsSync } from 'fs'
import { join, extname, basename, dirname } from 'path'

export interface SkillResult {
  success: boolean
  log: string
  result: string
  error?: string
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function getCategoryForExt(ext: string): string {
  const map: Record<string, string> = {
    '.jpg': 'Images', '.jpeg': 'Images', '.png': 'Images', '.gif': 'Images', '.bmp': 'Images', '.svg': 'Images', '.webp': 'Images',
    '.mp4': 'Videos', '.avi': 'Videos', '.mkv': 'Videos', '.mov': 'Videos', '.webm': 'Videos',
    '.mp3': 'Audio', '.wav': 'Audio', '.flac': 'Audio', '.aac': 'Audio', '.ogg': 'Audio',
    '.pdf': 'Documents', '.doc': 'Documents', '.docx': 'Documents', '.xls': 'Documents', '.xlsx': 'Documents', '.ppt': 'Documents', '.pptx': 'Documents', '.txt': 'Documents', '.rtf': 'Documents', '.csv': 'Documents',
    '.zip': 'Archives', '.rar': 'Archives', '.7z': 'Archives', '.tar': 'Archives', '.gz': 'Archives',
    '.js': 'Code', '.ts': 'Code', '.py': 'Code', '.java': 'Code', '.html': 'Code', '.css': 'Code', '.json': 'Code', '.md': 'Code',
    '.exe': 'Programs', '.msi': 'Programs', '.bat': 'Programs',
  }
  return map[ext] || 'Other'
}

// ─── Actual Filesystem Actions ───

export function writeFile(folder: string, fileName: string, content: string): SkillResult {
  try {
    const filePath = join(folder, fileName)
    // Ensure parent directory exists
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(filePath, content, 'utf-8')
    const stat = statSync(filePath)
    return {
      success: true,
      log: `Created file: ${filePath}\nSize: ${formatBytes(stat.size)}\n\n── Content ──\n${content.substring(0, 500)}${content.length > 500 ? '\n...' : ''}`,
      result: `File created: ${fileName} (${formatBytes(stat.size)})`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to write ${fileName}: ${err.message}`, result: '', error: err.message }
  }
}

export function readFile(folder: string, fileName: string): SkillResult {
  try {
    const filePath = join(folder, fileName)
    const content = readFileSync(filePath, 'utf-8')
    const stat = statSync(filePath)
    return {
      success: true,
      log: `Read file: ${filePath}\nSize: ${formatBytes(stat.size)}\n\n── Content ──\n${content.substring(0, 1000)}${content.length > 1000 ? '\n...' : ''}`,
      result: `Read ${fileName}: ${formatBytes(stat.size)}`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to read ${fileName}: ${err.message}`, result: '', error: err.message }
  }
}

export function listDir(folder: string): SkillResult {
  try {
    const entries = readdirSync(folder)
    const items: { name: string; size: number; isDir: boolean; ext: string }[] = []
    const categories: Record<string, string[]> = {}

    for (const entry of entries) {
      try {
        const fullPath = join(folder, entry)
        const stat = statSync(fullPath)
        const ext = stat.isDirectory() ? '' : extname(entry).toLowerCase()
        items.push({ name: entry, size: stat.size, isDir: stat.isDirectory(), ext })
        const cat = stat.isDirectory() ? 'Folders' : getCategoryForExt(ext)
        if (!categories[cat]) categories[cat] = []
        categories[cat].push(entry)
      } catch { /* skip */ }
    }

    const totalSize = items.reduce((s, f) => s + f.size, 0)
    const lines = [
      `Scanned: ${folder}`,
      `Found ${items.length} items (${formatBytes(totalSize)} total)`,
      '',
    ]
    for (const [cat, files] of Object.entries(categories).sort()) {
      lines.push(`${cat}: ${files.length} items`)
      for (const f of files.slice(0, 8)) {
        lines.push(`  • ${f}`)
      }
      if (files.length > 8) lines.push(`  ... and ${files.length - 8} more`)
    }
    return {
      success: true,
      log: lines.join('\n'),
      result: `${items.length} items in folder (${formatBytes(totalSize)})`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to list ${folder}: ${err.message}`, result: '', error: err.message }
  }
}

export function createDir(folder: string, dirName: string): SkillResult {
  try {
    const dirPath = join(folder, dirName)
    mkdirSync(dirPath, { recursive: true })
    return {
      success: true,
      log: `Created directory: ${dirPath}`,
      result: `Directory created: ${dirName}`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to create ${dirName}: ${err.message}`, result: '', error: err.message }
  }
}

export function moveFile(folder: string, from: string, to: string): SkillResult {
  try {
    const srcPath = join(folder, from)
    const destPath = join(folder, to)
    const destDir = dirname(destPath)
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    renameSync(srcPath, destPath)
    return {
      success: true,
      log: `Moved: ${from} → ${to}`,
      result: `Moved ${from} to ${to}`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to move ${from}: ${err.message}`, result: '', error: err.message }
  }
}

export function copyFile(folder: string, from: string, to: string): SkillResult {
  try {
    const srcPath = join(folder, from)
    const destPath = join(folder, to)
    const destDir = dirname(destPath)
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    copyFileSync(srcPath, destPath)
    const stat = statSync(destPath)
    return {
      success: true,
      log: `Copied: ${from} → ${to} (${formatBytes(stat.size)})`,
      result: `Copied ${from} to ${to}`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to copy ${from}: ${err.message}`, result: '', error: err.message }
  }
}

export function deleteFile(folder: string, fileName: string): SkillResult {
  try {
    const filePath = join(folder, fileName)
    const stat = statSync(filePath)
    unlinkSync(filePath)
    return {
      success: true,
      log: `Deleted: ${filePath} (${formatBytes(stat.size)})`,
      result: `Deleted ${fileName}`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to delete ${fileName}: ${err.message}`, result: '', error: err.message }
  }
}

export function appendFile(folder: string, fileName: string, content: string): SkillResult {
  try {
    const filePath = join(folder, fileName)
    const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
    writeFileSync(filePath, existing + content, 'utf-8')
    const stat = statSync(filePath)
    return {
      success: true,
      log: `Appended to: ${filePath}\nNew size: ${formatBytes(stat.size)}\n\n── Appended Content ──\n${content.substring(0, 300)}`,
      result: `Appended to ${fileName} (${formatBytes(stat.size)})`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to append to ${fileName}: ${err.message}`, result: '', error: err.message }
  }
}

export function searchFiles(folder: string, pattern: string): SkillResult {
  try {
    const results: string[] = []
    // Convert glob patterns to regex: * → .*, ? → ., escape other special chars
    const safePattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars (except * and ?)
      .replace(/\*/g, '.*')                   // glob * → regex .*
      .replace(/\?/g, '.')                    // glob ? → regex .
    const regex = new RegExp(safePattern, 'i')

    function searchDir(dir: string, depth: number) {
      if (depth > 5) return
      try {
        for (const entry of readdirSync(dir)) {
          const fullPath = join(dir, entry)
          try {
            const stat = statSync(fullPath)
            if (stat.isDirectory()) {
              if (regex.test(entry)) results.push(`📁 ${fullPath}`)
              searchDir(fullPath, depth + 1)
            } else {
              if (regex.test(entry)) results.push(`📄 ${fullPath} (${formatBytes(stat.size)})`)
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    searchDir(folder, 0)
    const lines = [
      `Searching for "${pattern}" in ${folder}`,
      `Found ${results.length} matches:`,
      '',
      ...results.slice(0, 20),
    ]
    if (results.length > 20) lines.push(`... and ${results.length - 20} more`)

    return {
      success: true,
      log: lines.join('\n'),
      result: `Found ${results.length} matches for "${pattern}"`,
    }
  } catch (err: any) {
    return { success: false, log: `Search failed: ${err.message}`, result: '', error: err.message }
  }
}

// ─── Organise: actually move files into category subdirectories ───

export function organiseFolder(folder: string): SkillResult {
  try {
    const entries = readdirSync(folder)
    const moved: string[] = []
    const created = new Set<string>()

    for (const entry of entries) {
      const fullPath = join(folder, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isDirectory()) continue

        const ext = extname(entry).toLowerCase()
        const cat = getCategoryForExt(ext)
        const catDir = join(folder, cat)

        if (!existsSync(catDir)) {
          mkdirSync(catDir, { recursive: true })
          created.add(cat)
        }

        renameSync(fullPath, join(catDir, entry))
        moved.push(`${entry} → ${cat}/${entry}`)
      } catch { /* skip */ }
    }

    const lines = [
      `Organised ${folder}`,
      '',
      `Created ${created.size} folders: ${[...created].join(', ')}`,
      `Moved ${moved.length} files:`,
      '',
      ...moved.slice(0, 20).map(m => `  ✓ ${m}`),
    ]
    if (moved.length > 20) lines.push(`  ... and ${moved.length - 20} more`)

    return {
      success: true,
      log: lines.join('\n'),
      result: `Organised ${moved.length} files into ${created.size} category folders`,
    }
  } catch (err: any) {
    return { success: false, log: `Failed to organise: ${err.message}`, result: '', error: err.message }
  }
}
