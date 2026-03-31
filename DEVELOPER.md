# Wispyr Developer Guide

This document covers the architecture, development setup, conventions, and internals for contributors and maintainers.

---

## Architecture Overview

Wispyr is a **fat client** Electron application. Everything runs inside the Electron process -- there is no separate backend server, no Python, no local HTTP server. The only outbound network call is to the configured LLM API.

```
User types task
      |
[React Renderer] -- Home.tsx TaskInput
      | contextBridge IPC (invoke/handle)
[Electron Main] -- ipc/register.ts
      |
[Task Parser] -- agent/task-parser.ts
      |  calls LLM for planning (or regex fallback)
[LLM Client] -- llm/call.ts
      |  supports: Azure OpenAI, OpenAI, Anthropic, Gemini, Groq, Ollama
[Plan Preview] -- returned to renderer for approval
      |
[Executor] -- ipc/register.ts executeApprovedPlan()
      |  runs each step using skills
[Skills] -- skills/filesystem.skill.ts + skills/filehandlers.ts
      |  actual file operations on disk
[Store] -- store/*.store.ts (electron-store)
      |  persists tasks, providers, workflows, audit log
[Renderer] -- polls task store for live progress
```

### Key Design Decisions

1. **No IPC events for plan delivery** -- `agent:run` awaits the LLM call and returns the plan in the IPC response. This avoids event timing issues with Electron's contextBridge.

2. **Polling for execution progress** -- The renderer polls the task store every 800ms during execution instead of relying on `webContents.send()` events. This is more reliable across Electron versions.

3. **Lazy store initialization** -- All `electron-store` instances are created lazily (on first access) to avoid accessing `app.getPath('userData')` before Electron's `app.whenReady()`.

4. **ELECTRON_RUN_AS_NODE fix** -- VS Code and Claude Code set `ELECTRON_RUN_AS_NODE=1` in their terminals, which breaks Electron. The `scripts/dev.js` launcher deletes this env var before spawning electron-vite.

5. **Rich file types via structured data** -- For binary formats (Excel, Word, PDF, PPTX), the LLM returns structured JSON data (not raw binary). File handler functions convert this structured data into actual files using libraries like ExcelJS, docx, pdfkit, etc.

---

## Development Setup

### Prerequisites

- Node.js >= 18
- npm >= 8
- Git

### First-time setup

```bash
git clone https://github.com/EldhosAji/wispyr.git
cd wispyr/apps/desktop
npm install
```

### Running in development

From the **project root**:

```bash
npm run dev
```

This runs `scripts/dev.js` which:
1. Deletes `ELECTRON_RUN_AS_NODE` from the environment
2. Spawns `electron-vite dev` which:
   - Builds main + preload as CJS bundles
   - Starts Vite dev server for the renderer (with HMR)
   - Launches Electron pointing at the dev server

### Building

```bash
npm run build          # Build all bundles (main, preload, renderer)
npm run build:win      # Build + package for Windows (NSIS + portable + ZIP)
npm run clean          # Remove build artifacts
```

---

## Code Walkthrough

### Main Process (`src/main/`)

#### `index.ts`
App entry point. Creates the frameless BrowserWindow, registers IPC handlers, handles portable mode detection.

#### `ipc/register.ts`
Central IPC handler registration. Contains:
- **`agent:run`** -- Creates task, calls LLM planner, returns plan to renderer
- **`plan:approve`** / **`plan:reject`** -- Starts or cancels execution
- **`executeApprovedPlan()`** -- Walks through steps, checks permissions, calls skills
- **`executeStepAction()`** -- Dispatches to the correct skill based on action type
- Provider, plugin, workflow, audit, and settings CRUD handlers
- Window controls (minimize, maximize, close)

#### `agent/task-parser.ts`
Two-tier task planning:
1. **LLM planner** (primary) -- Sends task + system prompt to the configured LLM. The system prompt describes all available actions and file types with exact JSON schemas. The LLM returns a JSON array of steps.
2. **Regex fallback** -- If no LLM is configured or the call fails, uses pattern matching to detect intent (create, read, delete, move, search, organise) and builds steps.

#### `llm/call.ts`
Multi-provider LLM client. Supports:
- **Anthropic** -- `/v1/messages` with `x-api-key` auth
- **Azure OpenAI** -- `/openai/deployments/{model}/chat/completions` with `api-key` header and `max_completion_tokens`
- **OpenAI / Groq / Custom** -- `/v1/chat/completions` with Bearer auth
- **Ollama** -- `/api/chat` (no auth)
- **Gemini** -- `/v1beta/models/{model}:generateContent` with URL key param

Each provider has its own request builder and response parser. All use raw `http`/`https` (no SDK dependencies).

#### `skills/filesystem.skill.ts`
Core file operations: `writeFile`, `readFile`, `listDir`, `createDir`, `deleteFile`, `moveFile`, `copyFile`, `appendFile`, `searchFiles`, `organiseFolder`. Operates within the user-approved working folder.

#### `skills/filehandlers.ts`
Rich file type support. Router function `writeRichFile()` / `readRichFile()` dispatches to type-specific handlers based on extension:
- **Excel** -- ExcelJS with styled headers, auto-filter, multi-sheet
- **Word** -- docx library with headings, paragraphs, bullets, tables
- **PDF** -- PDFKit with title, headings, tables, lists
- **PowerPoint** -- PptxGenJS with slides, bullets, speaker notes
- **CSV** -- csv-parse/csv-stringify
- **ZIP** -- adm-zip
- **YAML** -- js-yaml

#### `store/*.store.ts`
Persistence layer using `electron-store` (JSON files in `%APPDATA%/wispyr-desktop/`):
- `providers.store.ts` -- LLM provider configs + active provider
- `tasks.store.ts` -- Task history with steps
- `workflows.store.ts` -- Saved workflow templates
- `plugins.store.ts` -- Plugin registry + built-in skills
- `audit.store.ts` -- Append-only action audit log
- `settings.store.ts` -- App settings + permission rules

### Preload (`src/preload/index.ts`)
Exposes the `window.wispyr` API via `contextBridge`. All renderer-to-main communication goes through this. The API surface covers: agent, plan, permission, providers, plugins, workflows, audit, tasks, settings, fs, and window controls.

### Renderer (`src/renderer/`)

#### `App.tsx`
Root component. Manages active page, active provider state, and agent status. Passes provider info to TitleBar/StatusBar.

#### `pages/Home.tsx`
Main task execution UI:
1. Folder selector + task input area
2. "Generating plan..." spinner during LLM call
3. Plan preview with step list, permission badges, Start/Cancel buttons
4. Live step cards during execution (polled from store)
5. Permission modal (inline, with countdown for destructive)
6. Completion summary with expandable details

#### `pages/Settings.tsx`
Provider management with full CRUD form, test connection, set active. Tabbed UI for Providers, Permissions, Audit Log, General.

#### `pages/Tasks.tsx`, `Workflows.tsx`, `Plugins.tsx`
CRUD interfaces for task history, workflow templates, and plugin management.

#### `styles/globals.css` + `components.css`
Complete design system with CSS custom properties:
- Dark theme (default) + light theme (system-aware via `prefers-color-scheme`)
- Elevation system, semantic colors, permission level colors
- Component styles: cards, buttons, badges, inputs, step cards, plan preview, permission modal

---

## Adding a New Skill

1. Create `src/main/skills/yourskill.ts` with action functions
2. Add action cases to `executeStepAction()` in `ipc/register.ts`
3. Update the `PLAN_SYSTEM_PROMPT` in `task-parser.ts` to describe the new actions
4. The LLM will automatically start using the new skill when relevant

## Adding a New LLM Provider

1. Add the type to `ProviderConfig.type` in `providers.store.ts`
2. Add a call function in `llm/call.ts`
3. Add the type to the switch in `callLLM()`
4. Add defaults in `Settings.tsx` `PROVIDER_DEFAULTS`
5. Add the `<option>` in the Settings provider type dropdown
6. Add test connection logic in `register.ts` `testProviderConnection()`
7. Add default models in the `providers:models` handler

## Adding a New File Type

1. Add write/read functions in `filehandlers.ts`
2. Add the extension to the `isRichFileType()` check
3. Add cases to `writeRichFile()` and `readRichFile()`
4. Update the `PLAN_SYSTEM_PROMPT` in `task-parser.ts` with the JSON schema
5. The LLM will start generating the correct structured data

---

## Known Limitations

- **No real LLM tool calling** -- The agent uses a system prompt to get JSON plans from the LLM. It doesn't use function calling / tool use APIs yet.
- **No streaming** -- LLM responses are received in full, not streamed.
- **No multi-turn context** -- Each task is a single LLM call. The agent doesn't have memory of previous tasks within a session.
- **File operations only** -- No browser automation, desktop control, or shell commands yet (planned for Phases 6-8).
- **PDF reading** -- Basic page count only (no text extraction in Electron due to pdf-parse compatibility issues).
- **No undo** -- File operations are not reversible from the UI.

---

## Data Storage

All persistent data is stored in `%APPDATA%/wispyr-desktop/`:

| File | Contents |
|------|----------|
| `providers.json` | LLM provider configs + API keys |
| `tasks.json` | Task history with all steps |
| `workflows.json` | Saved workflow templates |
| `plugins.json` | User-installed plugins |
| `audit.json` | Action audit log |
| `settings.json` | App preferences |

In portable mode (`PORTABLE_EXECUTABLE_DIR` is set), data is stored in `Wispyr-data/` next to the `.exe`.

> **Security note**: API keys are currently stored in plain JSON. Phase 2+ will migrate to Windows Credential Manager via `keytar`.
