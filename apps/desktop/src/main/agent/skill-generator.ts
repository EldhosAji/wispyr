/**
 * Skill Generator — asks the LLM to write code for a missing capability,
 * tests it in the sandbox, and if it works, saves it as a permanent skill.
 *
 * Flow:
 * 1. Agent engine detects a task it can't handle with existing tools
 * 2. Calls generateSkill() with a description of what's needed
 * 3. LLM writes Node.js code
 * 4. Code runs in sandbox to verify it works
 * 5. If successful, skill is saved and registered as a tool
 */
import type { ProviderConfig } from '../store/providers.store'
import { callLLM } from '../llm/call'
import { executeSandboxed, type SandboxResult } from './sandbox'
import { saveSkill, type GeneratedSkill } from './skill-store'
import { registerTool, type ToolResult, type ToolContext } from './tool-registry'

// ─── Types ───

export interface SkillGenerationResult {
  success: boolean
  skill?: GeneratedSkill
  testResult?: SandboxResult
  error?: string
}

// ─── Main Entry ───

/**
 * Generate a new skill by asking the LLM to write code.
 * Tests in sandbox, saves on success.
 */
export async function generateSkill(
  provider: ProviderConfig,
  taskDescription: string,
  folder: string,
  onProgress?: (msg: string) => void,
): Promise<SkillGenerationResult> {
  onProgress?.('Generating code for new skill...')

  // Step 1: Ask LLM to write the code
  console.log(`[SkillGen] Calling LLM to generate code. Provider: ${provider.type}/${provider.model}`)
  const codeResponse = await callLLM(provider, [
    { role: 'system', content: SKILL_GENERATION_PROMPT },
    { role: 'user', content: `Task the skill should accomplish: "${taskDescription}"\nWorking folder: ${folder}` },
  ])

  console.log(`[SkillGen] LLM response: content=${codeResponse.content?.length || 0} chars, error=${codeResponse.error || 'none'}`)

  if (codeResponse.error) {
    return { success: false, error: `LLM error: ${codeResponse.error}` }
  }
  if (!codeResponse.content || codeResponse.content.trim().length === 0) {
    return { success: false, error: 'LLM returned empty response — model may have refused the request' }
  }

  // Step 2: Parse the response
  const parsed = parseSkillResponse(codeResponse.content)
  if (!parsed) {
    return { success: false, error: 'Failed to parse skill code from LLM response' }
  }

  onProgress?.(`Testing skill "${parsed.name}" in sandbox...`)

  // Step 3: Test in sandbox
  const testResult = await executeSandboxed({
    folder,
    code: parsed.code,
    timeout: 30000,
    args: parsed.testArgs || {},
  })

  if (!testResult.success) {
    onProgress?.(`Skill test failed: ${testResult.error}. Retrying...`)

    // Step 3b: One retry — send the error back to the LLM for a fix
    const fixResponse = await callLLM(provider, [
      { role: 'system', content: SKILL_GENERATION_PROMPT },
      { role: 'user', content: `Task: "${taskDescription}"\nWorking folder: ${folder}` },
      { role: 'assistant', content: codeResponse.content },
      { role: 'user', content: `The code failed with this error:\n${testResult.error}\n${testResult.output}\n\nPlease fix the code and respond with the corrected version in the same JSON format.` },
    ])

    if (fixResponse.content) {
      const fixedParsed = parseSkillResponse(fixResponse.content)
      if (fixedParsed) {
        const retryResult = await executeSandboxed({
          folder,
          code: fixedParsed.code,
          timeout: 30000,
          args: fixedParsed.testArgs || {},
        })

        if (retryResult.success) {
          // Fixed version works
          onProgress?.(`Skill "${fixedParsed.name}" tested successfully!`)
          return saveAndRegister(fixedParsed, retryResult, onProgress)
        }
      }
    }

    return { success: false, error: `Skill test failed: ${testResult.error}`, testResult }
  }

  onProgress?.(`Skill "${parsed.name}" tested successfully!`)

  // Step 4: Save and register
  return saveAndRegister(parsed, testResult, onProgress)
}

// ─── Save & Register ───

function saveAndRegister(
  parsed: ParsedSkill,
  testResult: SandboxResult,
  onProgress?: (msg: string) => void,
): SkillGenerationResult {
  const skill: GeneratedSkill = {
    id: `gen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: parsed.name,
    description: parsed.description,
    code: parsed.code,
    parameters: parsed.parameters,
    permissionLevel: parsed.permissionLevel || 'write',
    createdAt: new Date().toISOString(),
    version: 1,
    enabled: true,
  }

  // Save to disk
  saveSkill(skill)
  onProgress?.(`Skill "${skill.name}" installed as plugin!`)

  // Register as a live tool
  registerGeneratedTool(skill)

  return { success: true, skill, testResult }
}

/** Register a generated skill as a tool in the registry */
export function registerGeneratedTool(skill: GeneratedSkill): void {
  registerTool({
    name: `gen.${skill.name}`,
    description: `[Generated] ${skill.description}`,
    parameters: skill.parameters.map(p => ({
      name: p.name,
      type: (p.type as any) || 'string',
      description: p.description,
      required: p.required !== false,
    })),
    permissionLevel: skill.permissionLevel as any || 'write',
    concurrencySafe: false,
    async execute(params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const result = await executeSandboxed({
        folder: ctx.folder,
        code: skill.code,
        args: params,
        timeout: 30000,
      })

      return {
        success: result.success,
        log: result.output || result.error || '',
        result: result.success ? (result.output || 'Done') : '',
        error: result.error,
      }
    },
  })

  console.log(`[SkillGen] Registered tool: gen.${skill.name}`)
}

// ─── Response Parsing ───

interface ParsedSkill {
  name: string
  description: string
  code: string
  parameters: Array<{ name: string; type: string; description: string; required?: boolean }>
  permissionLevel?: string
  testArgs?: Record<string, any>
}

function parseSkillResponse(text: string): ParsedSkill | null {
  try {
    // Extract JSON from markdown code block or raw text
    let jsonStr = text.trim()
    const codeBlock = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (codeBlock) jsonStr = codeBlock[1].trim()

    const start = jsonStr.indexOf('{')
    const end = jsonStr.lastIndexOf('}')
    if (start === -1 || end === -1) return null
    jsonStr = jsonStr.substring(start, end + 1)

    const data = JSON.parse(jsonStr)
    if (!data.name || !data.code) return null

    return {
      name: data.name.toLowerCase().replace(/\s+/g, '_'),
      description: data.description || data.name,
      code: data.code,
      parameters: data.parameters || [],
      permissionLevel: data.permissionLevel || 'write',
      testArgs: data.testArgs || {},
    }
  } catch {
    return null
  }
}

// ─── System Prompt ───

const SKILL_GENERATION_PROMPT = `You generate Node.js code for a desktop AI agent. Respond with ONLY a JSON object, no other text.

FORMAT:
{
  "name": "skill_name",
  "description": "One sentence",
  "code": "// your code here",
  "parameters": [],
  "permissionLevel": "write",
  "testArgs": {}
}

AVAILABLE IN CODE:
- fs.readFile(path), fs.readFileBuffer(path), fs.writeFile(path, content)
- fs.writeFileStream(path) → WriteStream
- fs.exists(path), fs.listDir(path?), fs.stat(path), fs.mkdir(path)
- fs.rename(from, to), fs.copy(from, to), fs.delete(path)
- fs.scopedPath(path) → absolute path within working folder
- fs.join(), fs.extname(), fs.basename(), fs.dirname()
- require('exceljs') — Excel with charts, styling, formulas
- require('pdfkit') — PDF creation
- require('docx') — Word documents
- require('pptxgenjs') — PowerPoint
- require('adm-zip') — ZIP files
- require('js-yaml') — YAML
- require('sharp') — image processing (resize, convert)
- require('csv-stringify/sync'), require('csv-parse/sync')
- args, folder, console.log()

RULES:
- Code runs in async function. Use await freely.
- File paths relative to working folder (auto-scoped).
- Use fs.scopedPath(name) to get the full path for libraries that need absolute paths.
- For ExcelJS: use workbook.xlsx.writeFile(fs.scopedPath('file.xlsx'))
- ALWAYS create the actual file, not just describe it.
- testArgs should be safe (read-only test or create a small test file).

EXAMPLE — Excel with chart:
{
  "name": "excel_with_chart",
  "description": "Create Excel with data and pie chart",
  "code": "const ExcelJS = require('exceljs');\\nconst wb = new ExcelJS.Workbook();\\nconst ws = wb.addWorksheet('Data');\\nws.columns = [{header:'Category',key:'cat',width:15},{header:'Amount',key:'amt',width:12}];\\nws.addRow({cat:'Food',amt:500});\\nws.addRow({cat:'Rent',amt:1200});\\nws.getRow(1).font = {bold:true,color:{argb:'FFFFFFFF'}};\\nws.getRow(1).fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF4472C4'}};\\nawait wb.xlsx.writeFile(fs.scopedPath('output.xlsx'));\\nconsole.log('Created Excel file');",
  "parameters": [],
  "permissionLevel": "write",
  "testArgs": {}
}`
