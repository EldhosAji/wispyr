/**
 * generate_skill tool — lets the LLM create new capabilities on the fly.
 *
 * When the LLM needs to do something no existing tool supports
 * (e.g. add charts to Excel, resize images, parse PDFs),
 * it calls this tool with a description. The system then:
 * 1. Asks the LLM to write Node.js code
 * 2. Tests it in a sandbox
 * 3. Executes it
 * 4. Saves it as a permanent plugin
 */
import { registerTool, type ToolContext, type ToolResult } from '../tool-registry'
import { generateSkill } from '../skill-generator'
import { executeSandboxed } from '../sandbox'
import { updateSkillUsage } from '../skill-store'
import * as providersStore from '../../store/providers.store'

export function registerGenerateSkillTool(): void {
  registerTool({
    name: 'generate_skill',
    description: 'Auto-generate and run custom code for tasks no other tool can do (e.g. charts, image processing, data transforms).',
    parameters: [
      {
        name: 'task',
        type: 'string',
        description: 'What the code should do, including file names and requirements.',
        required: true,
      },
    ],
    permissionLevel: 'write',
    concurrencySafe: false,
    async execute(params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const provider = providersStore.getActiveProvider()
      if (!provider) {
        return { success: false, log: 'No LLM provider configured', result: '', error: 'No LLM provider' }
      }

      const taskDescription = buildTaskDescription(params, ctx.folder)

      try {
        const result = await generateSkill(
          provider,
          taskDescription,
          ctx.folder,
          (msg) => console.log(`[generate_skill] ${msg}`),
        )

        if (!result.success) {
          return {
            success: false,
            log: `Failed to generate skill: ${result.error}\n${result.testResult?.output || ''}`,
            result: '',
            error: result.error || 'Skill generation failed',
          }
        }

        // Skill was generated, tested, and saved
        const skill = result.skill!
        updateSkillUsage(skill.name)

        return {
          success: true,
          log: `Generated and executed skill "${skill.name}"\n\nExecution output:\n${result.testResult?.output || 'Done'}`,
          result: `Skill "${skill.name}" created and executed successfully. ${result.testResult?.output || ''}`,
        }
      } catch (err: any) {
        return {
          success: false,
          log: `Skill generation error: ${err.message}`,
          result: '',
          error: err.message,
        }
      }
    },
  })
}

function buildTaskDescription(params: Record<string, any>, folder: string): string {
  const parts = [params.task || 'No task description provided']

  if (params.input_files) {
    parts.push(`\nInput files (in working folder): ${params.input_files}`)
  }
  if (params.output_file) {
    parts.push(`Expected output file: ${params.output_file}`)
  }

  parts.push(`\nWorking folder: ${folder}`)

  return parts.join('\n')
}
