/**
 * Agent Initialization — registers all tools on startup.
 * Loads built-in tools and previously generated skills.
 */
import { registerFilesystemTools } from './tools/filesystem.tools'
import { registerGenerateSkillTool } from './tools/generate-skill.tool'
import { loadAllSkills } from './skill-store'
import { registerGeneratedTool } from './skill-generator'

let _initialized = false

export function initializeAgent(): void {
  if (_initialized) return
  _initialized = true

  // Register built-in tools
  registerFilesystemTools()
  registerGenerateSkillTool()

  // Load and register previously generated skills
  const savedSkills = loadAllSkills()
  let loadedCount = 0
  for (const skill of savedSkills) {
    if (skill.enabled) {
      try {
        registerGeneratedTool(skill)
        loadedCount++
      } catch (err: any) {
        console.log(`[Agent] Failed to load skill "${skill.name}": ${err.message}`)
      }
    }
  }

  console.log(`[Agent] Initialized — ${10} built-in tools, ${loadedCount} generated skills loaded`)
}
