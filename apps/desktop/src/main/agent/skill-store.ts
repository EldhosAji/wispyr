/**
 * Skill Store — persists LLM-generated skills to disk and loads them on startup.
 *
 * Skills are stored as JSON files in the user's data directory:
 *   ~/.wispyr/generated-skills/ (or %APPDATA%/wispyr-desktop/generated-skills/)
 *
 * Each skill file contains the code, parameters, and metadata.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

// ─── Types ───

export interface GeneratedSkill {
  id: string
  name: string
  description: string
  code: string
  parameters: Array<{
    name: string
    type: string
    description: string
    required?: boolean
  }>
  permissionLevel: string
  createdAt: string
  version: number
  enabled: boolean
  /** How many times this skill has been used successfully */
  useCount?: number
  /** Last time this skill was used */
  lastUsed?: string
}

// ─── Paths ───

function getSkillsDir(): string {
  try {
    return join(app.getPath('userData'), 'generated-skills')
  } catch {
    return join(process.cwd(), '.generated-skills')
  }
}

function ensureSkillsDir(): string {
  const dir = getSkillsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// ─── CRUD ───

export function saveSkill(skill: GeneratedSkill): void {
  const dir = ensureSkillsDir()
  const filePath = join(dir, `${skill.name}.json`)
  writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf-8')
  console.log(`[SkillStore] Saved skill: ${skill.name} → ${filePath}`)
}

export function loadSkill(name: string): GeneratedSkill | null {
  const filePath = join(getSkillsDir(), `${name}.json`)
  try {
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

export function loadAllSkills(): GeneratedSkill[] {
  const dir = getSkillsDir()
  if (!existsSync(dir)) return []

  const skills: GeneratedSkill[] = []
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const data = JSON.parse(readFileSync(join(dir, file), 'utf-8'))
        if (data.name && data.code) {
          skills.push(data)
        }
      } catch { /* skip invalid files */ }
    }
  } catch { /* dir read failed */ }

  return skills
}

export function deleteSkill(name: string): boolean {
  const filePath = join(getSkillsDir(), `${name}.json`)
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath)
      console.log(`[SkillStore] Deleted skill: ${name}`)
      return true
    }
    return false
  } catch {
    return false
  }
}

export function updateSkillUsage(name: string): void {
  const skill = loadSkill(name)
  if (!skill) return
  skill.useCount = (skill.useCount || 0) + 1
  skill.lastUsed = new Date().toISOString()
  saveSkill(skill)
}

export function toggleSkill(name: string, enabled: boolean): boolean {
  const skill = loadSkill(name)
  if (!skill) return false
  skill.enabled = enabled
  saveSkill(skill)
  return true
}
