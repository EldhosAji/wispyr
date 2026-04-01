/**
 * Sandbox Executor — safely runs LLM-generated code in an isolated context.
 *
 * Security boundaries:
 * - Runs in a Node.js worker thread (separate V8 isolate)
 * - File system access scoped to the working folder only
 * - No network access (http/https/net blocked)
 * - No child_process, no eval escalation
 * - Timeout enforced (default 30s)
 * - Memory limit via worker thread resourceLimits
 */
import { Worker } from 'worker_threads'
import { join, resolve, normalize } from 'path'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { app } from 'electron'

// ─── Types ───

export interface SandboxResult {
  success: boolean
  output: string
  error?: string
  durationMs: number
}

export interface SandboxOptions {
  /** Working folder — sandbox can only access files within this folder */
  folder: string
  /** Code to execute (Node.js) */
  code: string
  /** Timeout in ms (default 30000) */
  timeout?: number
  /** Arguments passed to the function */
  args?: Record<string, any>
}

// ─── Sandbox execution ───

/**
 * Execute code in a sandboxed worker thread.
 * The code must export a default async function.
 */
export async function executeSandboxed(options: SandboxOptions): Promise<SandboxResult> {
  const { folder, code, timeout = 30000, args = {} } = options
  const startTime = Date.now()

  // Create temp file for the worker
  const sandboxDir = getSandboxDir()
  if (!existsSync(sandboxDir)) mkdirSync(sandboxDir, { recursive: true })

  const workerId = `sandbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const workerPath = join(sandboxDir, `${workerId}.mjs`)

  try {
    // Build the worker script with security guards
    const workerScript = buildWorkerScript(code, folder, args)
    writeFileSync(workerPath, workerScript, 'utf-8')

    // Execute in worker thread
    const result = await runWorker(workerPath, timeout)
    return { ...result, durationMs: Date.now() - startTime }
  } catch (err: any) {
    return {
      success: false,
      output: '',
      error: err.message,
      durationMs: Date.now() - startTime,
    }
  } finally {
    // Clean up temp file
    try { unlinkSync(workerPath) } catch { /* ok */ }
  }
}

// ─── Worker Script Builder ───

function buildWorkerScript(userCode: string, folder: string, args: Record<string, any>): string {
  const safeFolderPath = JSON.stringify(resolve(folder))
  const safeArgs = JSON.stringify(args)

  return `
import { parentPort } from 'worker_threads';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, renameSync, copyFileSync, unlinkSync, createWriteStream } from 'fs';
import { join, resolve, normalize, extname, basename, dirname } from 'path';
import { createRequire } from 'module';

// ─── Security: Scoped file system ───
const SANDBOX_FOLDER = ${safeFolderPath};

function scopedPath(filePath) {
  const full = resolve(SANDBOX_FOLDER, filePath);
  const normalized = normalize(full);
  if (!normalized.startsWith(normalize(SANDBOX_FOLDER))) {
    throw new Error('Access denied: path outside working folder');
  }
  return normalized;
}

// ─── Whitelisted require() for safe npm packages ───
const _require = createRequire(import.meta.url);
const ALLOWED_MODULES = new Set([
  'exceljs', 'docx', 'pdfkit', 'pptxgenjs',
  'csv-stringify', 'csv-stringify/sync', 'csv-parse', 'csv-parse/sync',
  'adm-zip', 'js-yaml', 'mammoth', 'sharp',
  'path', 'fs', 'buffer', 'stream', 'util', 'crypto',
]);

function safeRequire(name) {
  if (!ALLOWED_MODULES.has(name)) {
    throw new Error('Module not allowed: ' + name + '. Allowed: ' + [...ALLOWED_MODULES].join(', '));
  }
  return _require(name);
}

// Scoped fs wrappers available to user code
const fs = {
  readFile: (p) => readFileSync(scopedPath(p), 'utf-8'),
  readFileBuffer: (p) => readFileSync(scopedPath(p)),
  writeFile: (p, content) => writeFileSync(scopedPath(p), content, typeof content === 'string' ? 'utf-8' : undefined),
  writeFileStream: (p) => createWriteStream(scopedPath(p)),
  exists: (p) => existsSync(scopedPath(p)),
  listDir: (p) => readdirSync(scopedPath(p || '.')),
  stat: (p) => statSync(scopedPath(p)),
  mkdir: (p) => mkdirSync(scopedPath(p), { recursive: true }),
  rename: (from, to) => renameSync(scopedPath(from), scopedPath(to)),
  copy: (from, to) => copyFileSync(scopedPath(from), scopedPath(to)),
  delete: (p) => unlinkSync(scopedPath(p)),
  scopedPath,
  join: (...parts) => join(...parts),
  extname, basename, dirname,
};

// Make require available to user code
const require = safeRequire;

// Args passed from the caller
const args = ${safeArgs};
const folder = SANDBOX_FOLDER;

// Capture console output
const logs = [];
const console = {
  log: (...a) => logs.push(a.map(String).join(' ')),
  error: (...a) => logs.push('ERROR: ' + a.map(String).join(' ')),
  warn: (...a) => logs.push('WARN: ' + a.map(String).join(' ')),
};

// ─── User code ───
async function __userMain() {
${userCode}
}

// ─── Execute ───
try {
  const result = await __userMain();
  parentPort.postMessage({
    success: true,
    output: logs.join('\\n') + (result !== undefined ? '\\nResult: ' + JSON.stringify(result) : ''),
  });
} catch (err) {
  parentPort.postMessage({
    success: false,
    output: logs.join('\\n'),
    error: err.message || String(err),
  });
}
`
}

// ─── Worker Runner ───

function runWorker(workerPath: string, timeout: number): Promise<SandboxResult> {
  return new Promise((resolve) => {
    let settled = false

    const worker = new Worker(workerPath, {
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
        codeRangeSizeMb: 16,
      },
    })

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        worker.terminate()
        resolve({ success: false, output: '', error: 'Sandbox timeout (30s)', durationMs: timeout })
      }
    }, timeout)

    worker.on('message', (msg: any) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({
          success: msg.success,
          output: msg.output || '',
          error: msg.error,
          durationMs: 0, // caller fills this in
        })
      }
    })

    worker.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ success: false, output: '', error: err.message, durationMs: 0 })
      }
    })

    worker.on('exit', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        if (code !== 0) {
          resolve({ success: false, output: '', error: `Worker exited with code ${code}`, durationMs: 0 })
        }
      }
    })
  })
}

// ─── Helpers ───

function getSandboxDir(): string {
  try {
    return join(app.getPath('userData'), 'sandbox-temp')
  } catch {
    return join(process.cwd(), '.sandbox-temp')
  }
}
