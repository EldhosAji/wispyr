/**
 * Filesystem tools — registers all filesystem operations as tools
 * in the Wispyr tool registry.
 */
import { registerTool, type ToolContext, type ToolResult } from '../tool-registry'
import * as fsSkill from '../../skills/filesystem.skill'
import * as fileHandlers from '../../skills/filehandlers'
import { basename, join, extname } from 'path'

export function registerFilesystemTools(): void {
  // ─── write_file ───
  registerTool({
    name: 'write_file',
    description: 'Create or overwrite a file. Use "content" for text files, "data" for binary files (.xlsx, .docx, .pdf, .pptx).',
    parameters: [
      { name: 'fileName', type: 'string', description: 'File name to create', required: true },
      { name: 'content', type: 'string', description: 'Text content (for .txt, .md, .json, .csv, .html, etc.)', required: false },
      { name: 'data', type: 'object', description: 'Structured JSON for binary files. Excel: {sheets:[{name,headers,rows}]}. Word: {title,content:[{type,text}]}. PDF: {title,content:[{type,text}]}. PPTX: {slides:[{title,bullets}]}', required: false },
    ],
    permissionLevel: 'write',
    concurrencySafe: false,
    async execute(params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const fileName = basename(params.fileName || 'output.txt')
      const filePath = join(ctx.folder, fileName)
      const ext = extname(fileName).toLowerCase()

      // Binary formats (.xlsx, .docx, .pdf, .pptx) MUST use structured data
      const binaryFormats = ['.xlsx', '.xls', '.docx', '.pdf', '.pptx']
      // Text-based rich formats (.csv, .yaml) can accept plain text
      const textRichFormats = ['.csv', '.zip', '.yaml', '.yml']

      if (binaryFormats.includes(ext)) {
        if (params.data && typeof params.data === 'object') {
          return await fileHandlers.writeRichFile(filePath, params.data)
        }
        // No structured data — return error so LLM retries with correct format
        const formatHelp: Record<string, string> = {
          '.xlsx': '{"sheets":[{"name":"Sheet1","headers":["Col1","Col2"],"rows":[["val1","val2"]]}]}',
          '.xls': '{"sheets":[{"name":"Sheet1","headers":["Col1","Col2"],"rows":[["val1","val2"]]}]}',
          '.docx': '{"title":"Doc","content":[{"type":"paragraph","text":"Hello"}]}',
          '.pdf': '{"title":"Doc","content":[{"type":"paragraph","text":"Hello"}]}',
          '.pptx': '{"title":"Pres","slides":[{"title":"Slide 1","bullets":["Point 1"]}]}',
        }
        return {
          success: false,
          log: `RETRY: Use "data" parameter instead of "content" for ${ext} files. Example: data: ${formatHelp[ext] || '{}'}`,
          result: '',
          error: `Retry with "data" parameter. Example: data: ${formatHelp[ext] || '{}'}`,
        }
      }

      if (textRichFormats.includes(ext)) {
        // Prefer structured data if available
        if (params.data && typeof params.data === 'object') {
          return await fileHandlers.writeRichFile(filePath, params.data)
        }
        // Plain text content is fine for CSV/YAML
        if (params.content && typeof params.content === 'string') {
          return fsSkill.writeFile(ctx.folder, fileName, params.content)
        }
        return await fileHandlers.writeRichFile(filePath, params)
      }

      // Plain text files
      return fsSkill.writeFile(ctx.folder, fileName, params.content || '')
    },
  })

  // ─── read_file ───
  registerTool({
    name: 'read_file',
    description: 'Read the contents of a file. Supports text files, Excel, Word, PDF, CSV, ZIP, YAML.',
    parameters: [
      { name: 'fileName', type: 'string', description: 'Name of the file to read', required: true },
    ],
    permissionLevel: 'read_only',
    concurrencySafe: true,
    async execute(params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const fileName = basename(params.fileName || '')
      const filePath = join(ctx.folder, fileName)

      // Check file cache first
      const cacheKey = filePath
      if (ctx.fileCache.has(cacheKey)) {
        const cached = ctx.fileCache.get(cacheKey)!
        return { success: true, log: `Read file (cached): ${filePath}\n\n── Content ──\n${cached.substring(0, 1000)}`, result: `Read ${fileName} (cached)` }
      }

      let result: ToolResult
      if (fileHandlers.isRichFileType(fileName)) {
        result = await fileHandlers.readRichFile(filePath)
      } else {
        result = fsSkill.readFile(ctx.folder, fileName)
      }

      // Cache successful reads
      if (result.success) {
        ctx.fileCache.set(cacheKey, result.log)
      }
      return result
    },
  })

  // ─── append_file ───
  registerTool({
    name: 'append_file',
    description: 'Append content to the end of an existing file.',
    parameters: [
      { name: 'fileName', type: 'string', description: 'Name of the file to append to', required: true },
      { name: 'content', type: 'string', description: 'Content to append', required: true },
    ],
    permissionLevel: 'write',
    concurrencySafe: false,
    async execute(params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const fileName = basename(params.fileName || '')
      ctx.fileCache.delete(join(ctx.folder, fileName)) // invalidate cache
      return fsSkill.appendFile(ctx.folder, fileName, params.content || '')
    },
  })

  // ─── list_dir ───
  registerTool({
    name: 'list_dir',
    description: 'List the contents of the working folder, showing files and subdirectories with sizes.',
    parameters: [],
    permissionLevel: 'read_only',
    concurrencySafe: true,
    async execute(_params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      return fsSkill.listDir(ctx.folder)
    },
  })

  // ─── create_dir ───
  registerTool({
    name: 'create_dir',
    description: 'Create a new subdirectory in the working folder.',
    parameters: [
      { name: 'dirName', type: 'string', description: 'Name of the directory to create', required: true },
    ],
    permissionLevel: 'write',
    concurrencySafe: false,
    async execute(params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      return fsSkill.createDir(ctx.folder, params.dirName || 'new_folder')
    },
  })

  // ─── delete_file ───
  registerTool({
    name: 'delete_file',
    description: 'Permanently delete a file from the working folder.',
    parameters: [
      { name: 'fileName', type: 'string', description: 'Name of the file to delete', required: true },
    ],
    permissionLevel: 'destructive',
    concurrencySafe: false,
    async execute(params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const fileName = basename(params.fileName || '')
      ctx.fileCache.delete(join(ctx.folder, fileName))
      return fsSkill.deleteFile(ctx.folder, fileName)
    },
  })

  // ─── move_file ───
  registerTool({
    name: 'move_file',
    description: 'Move or rename a file within the working folder.',
    parameters: [
      { name: 'from', type: 'string', description: 'Source file name (relative to working folder)', required: true },
      { name: 'to', type: 'string', description: 'Destination file name (relative to working folder)', required: true },
    ],
    permissionLevel: 'write',
    concurrencySafe: false,
    async execute(params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      ctx.fileCache.delete(join(ctx.folder, params.from || ''))
      return fsSkill.moveFile(ctx.folder, params.from || '', params.to || '')
    },
  })

  // ─── copy_file ───
  registerTool({
    name: 'copy_file',
    description: 'Copy a file within the working folder.',
    parameters: [
      { name: 'from', type: 'string', description: 'Source file name', required: true },
      { name: 'to', type: 'string', description: 'Destination file name', required: true },
    ],
    permissionLevel: 'write',
    concurrencySafe: false,
    async execute(params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      return fsSkill.copyFile(ctx.folder, params.from || '', params.to || '')
    },
  })

  // ─── search_files ───
  registerTool({
    name: 'search_files',
    description: 'Search for files matching a pattern (glob or keyword) in the working folder and subdirectories.',
    parameters: [
      { name: 'pattern', type: 'string', description: 'Search pattern (supports * and ? wildcards)', required: true },
    ],
    permissionLevel: 'read_only',
    concurrencySafe: true,
    async execute(params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      return fsSkill.searchFiles(ctx.folder, params.pattern || '*')
    },
  })

  // ─── organise ───
  registerTool({
    name: 'organise',
    description: 'Automatically sort files in the working folder into category subdirectories (Images, Documents, Code, etc.) based on file extension.',
    parameters: [],
    permissionLevel: 'write',
    concurrencySafe: false,
    async execute(_params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      return fsSkill.organiseFolder(ctx.folder)
    },
  })
}
