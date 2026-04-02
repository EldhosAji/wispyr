/**
 * Workflow Runner — executes saved workflow templates step by step.
 * Each step's prompt is sent to the agent engine with variable substitution.
 */
import { runAgent, type AgentEvent } from './engine'
import * as providersStore from '../store/providers.store'
import type { Workflow } from '../store/workflows.store'

// ─── Types ───

export interface WorkflowRunResult {
  success: boolean
  stepResults: Array<{ step: number; prompt: string; success: boolean; output: string; error?: string }>
  error?: string
}

export type WorkflowProgressCallback = (event: {
  type: 'workflow_start' | 'step_start' | 'step_complete' | 'step_error' | 'workflow_complete'
  step?: number
  totalSteps?: number
  stepName?: string
  output?: string
  error?: string
}) => void

// ─── Runner ───

export async function runWorkflow(
  workflow: Workflow,
  inputs: Record<string, string>,
  folder: string,
  onProgress?: WorkflowProgressCallback,
): Promise<WorkflowRunResult> {
  const provider = providersStore.getActiveProvider()
  if (!provider) {
    return { success: false, stepResults: [], error: 'No LLM provider configured' }
  }

  const steps = workflow.steps || []
  if (steps.length === 0) {
    return { success: false, stepResults: [], error: 'Workflow has no steps' }
  }

  onProgress?.({ type: 'workflow_start', totalSteps: steps.length })

  const stepResults: WorkflowRunResult['stepResults'] = []
  let prevOutput = ''

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const stepName = step.name || step.title || `Step ${i + 1}`

    // Substitute variables: {{var_name}} → input value, {{prev_output}} → previous step's output
    let prompt = step.prompt || step.description || stepName
    prompt = substituteVariables(prompt, inputs, prevOutput)

    onProgress?.({ type: 'step_start', step: i + 1, totalSteps: steps.length, stepName })

    const taskId = `wf_${workflow.id}_step${i + 1}_${Date.now()}`
    let stepOutput = ''
    let stepError: string | undefined

    try {
      await runAgent({
        taskId,
        folder,
        provider,
        message: prompt,
        maxTurns: 10,
        stream: false,
        onEvent: (event: AgentEvent) => {
          if (event.type === 'text_done' && event.text) {
            stepOutput = event.text
          } else if (event.type === 'tool_result' && event.toolResult?.result.success) {
            if (!stepOutput) stepOutput = event.toolResult.result.result
          } else if (event.type === 'error') {
            stepError = event.error
          }
        },
        onPermission: async () => true, // Workflows auto-approve
      })

      stepResults.push({ step: i + 1, prompt, success: !stepError, output: stepOutput, error: stepError })
      prevOutput = stepOutput

      onProgress?.({
        type: stepError ? 'step_error' : 'step_complete',
        step: i + 1, totalSteps: steps.length, stepName,
        output: stepOutput, error: stepError,
      })
    } catch (err: any) {
      stepResults.push({ step: i + 1, prompt, success: false, output: '', error: err.message })
      onProgress?.({ type: 'step_error', step: i + 1, totalSteps: steps.length, stepName, error: err.message })
      // Continue to next step even on failure
    }
  }

  const allPassed = stepResults.every(r => r.success)
  onProgress?.({ type: 'workflow_complete' })

  return { success: allPassed, stepResults }
}

// ─── Variable Substitution ───

function substituteVariables(
  prompt: string,
  inputs: Record<string, string>,
  prevOutput: string,
): string {
  let result = prompt

  // Replace {{input_name}} with input values
  for (const [key, value] of Object.entries(inputs)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value)
  }

  // Replace {{prev_output}} with previous step's output
  result = result.replace(/\{\{prev_output\}\}/g, prevOutput)

  // Replace {{date}} with current date
  result = result.replace(/\{\{date\}\}/g, new Date().toISOString().split('T')[0])

  return result
}
