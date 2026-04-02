/**
 * Agent Initialization — registers all tools on startup.
 * Loads built-in tools, generated skills, MCP connections, and starts scheduler.
 */
import { registerFilesystemTools } from './tools/filesystem.tools'
import { registerGenerateSkillTool } from './tools/generate-skill.tool'
import { registerShellTool } from './tools/shell.tool'
import { registerWebFetchTool } from './tools/web-fetch.tool'
import { registerAgentTool } from './tools/agent.tool'
import { registerScheduleTools } from './tools/schedule.tool'
import { loadAllSkills } from './skill-store'
import { registerGeneratedTool } from './skill-generator'
import { isFeatureEnabled } from '../store/settings.store'
import { startScheduler } from './scheduler'
import { getToolNames } from './tool-registry'

let _initialized = false

export function initializeAgent(): void {
  if (_initialized) return
  _initialized = true

  // Register built-in tools (always available)
  registerFilesystemTools()

  // Feature-gated tools
  if (isFeatureEnabled('shellTool')) {
    registerShellTool()
  }

  if (isFeatureEnabled('webFetchTool')) {
    registerWebFetchTool()
  }

  if (isFeatureEnabled('subAgents')) {
    registerAgentTool()
  }

  if (isFeatureEnabled('autoSkillGeneration')) {
    registerGenerateSkillTool()
  }

  if (isFeatureEnabled('scheduler')) {
    registerScheduleTools()
    startScheduler()
  }

  // Load previously generated skills
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

  const toolNames = getToolNames()
  console.log(`[Agent] Initialized — ${toolNames.length} tools registered (${loadedCount} generated skills)`)
  console.log(`[Agent] Tools: ${toolNames.join(', ')}`)
}
