# Wispyr

**The open-source AI agent that non-developers actually finish installing.**

Wispyr is a Windows-first desktop AI agent built with Electron, TypeScript, and React. Describe a task in plain language, approve the plan, and watch it execute step by step -- creating files, generating reports, organising folders, and more.

---

## Features

- **Natural language task execution** -- describe what you want in plain English
- **LLM-powered planning** -- your AI provider generates a step-by-step plan before anything runs
- **Plan preview & approval** -- review, edit, or cancel before execution starts
- **4-level permission system** -- READ (auto), WRITE (approve once), DESTRUCTIVE (every time), SYSTEM (type CONFIRM)
- **Rich file type support** -- Excel, Word, PDF, PowerPoint, CSV, ZIP, YAML, and all text formats
- **Multi-provider LLM support** -- Azure OpenAI, OpenAI, Anthropic Claude, Google Gemini, Groq, Ollama (local), or any OpenAI-compatible API
- **Real filesystem operations** -- files are actually created, moved, and deleted on disk
- **Task history & audit log** -- every action is logged and exportable
- **Workflow templates** -- save and reuse common tasks
- **Plugin system** -- built-in skills + community plugins + MCP auto-discovery
- **Dark/light theme** -- system-aware, VS Code-inspired design
- **Portable mode** -- run from USB with all data alongside the exe

## Supported File Types

| Type | Create | Read | Extensions |
|------|--------|------|------------|
| Excel | Styled sheets, headers, filters, multi-sheet | Full cell data | `.xlsx` |
| Word | Headings, paragraphs, bullets, tables | Text extraction | `.docx` |
| PDF | Title, headings, paragraphs, lists, tables | Page count + info | `.pdf` |
| PowerPoint | Slides, titles, bullets, speaker notes | -- | `.pptx` |
| CSV | Proper quoting, headers | Parsed table | `.csv` |
| ZIP | Bundle files | List contents | `.zip` |
| YAML | Structured data | Parse + display | `.yaml` `.yml` |
| Plain text | Any content | Full display | `.txt` `.md` `.json` `.html` `.js` `.py` `.ts` `.xml` `.sql` `.sh` `.bat` `.css` etc. |

## Quick Start

### Prerequisites

- **Node.js** >= 18
- **npm** >= 8
- An LLM provider (Azure OpenAI, OpenAI, Anthropic, Gemini, Groq, or local Ollama)

### Install & Run

```bash
git clone https://github.com/EldhosAji/wispyr.git
cd wispyr/apps/desktop
npm install
cd ../..
npm run dev
```

> **Note:** If running from VS Code's integrated terminal, the `dev` script automatically handles the `ELECTRON_RUN_AS_NODE` environment variable.

### Configure an LLM Provider

1. Open Wispyr
2. Go to **Settings** > **Providers**
3. Click **Add Provider**
4. Select your provider type and enter credentials:

| Provider | Base URL | API Key |
|----------|----------|---------|
| Ollama (local) | `http://localhost:11434` | No |
| Azure OpenAI | `https://your-resource.openai.azure.com` | Yes |
| OpenAI | `https://api.openai.com` | Yes |
| Anthropic | `https://api.anthropic.com` | Yes |
| Google Gemini | `https://generativelanguage.googleapis.com` | Yes |
| Groq | `https://api.groq.com` | Yes |

5. Click **Test** to verify, then **Activate**

### Your First Task

1. Pick a working directory
2. Type: `create a budget spreadsheet in expenses.xlsx`
3. Review the AI-generated plan
4. Click **Start** and approve write permissions
5. Check your folder -- the file is there

### Example Prompts

```
create a hello world txt
write a short story about a robot in story.txt
create a budget spreadsheet in expenses.xlsx with monthly data
generate a PDF invoice for client ABC
create a project status presentation in update.pptx
take data from expenses.xlsx and convert to a PDF report
organise this folder by file type
list all files in this folder
```

## Build for Distribution

```bash
npm run build          # Build all bundles
npm run build:win      # Build + package for Windows
```

Output:
- `Wispyr-Setup-{version}.exe` -- installer
- `Wispyr-{version}-portable.exe` -- portable
- `Wispyr-{version}-win.zip` -- zip archive

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 33 |
| Build tooling | electron-vite + Vite |
| Packaging | electron-builder |
| Frontend | React 18 + TypeScript |
| State | Zustand, electron-store |
| Icons | Lucide React |
| Styling | Custom CSS design system |
| Excel | ExcelJS |
| Word | docx (write), mammoth (read) |
| PDF | PDFKit |
| PowerPoint | PptxGenJS |
| CSV | csv-parse, csv-stringify |
| ZIP | adm-zip |
| YAML | js-yaml |

## Project Structure

```
wispyr/
├── apps/desktop/
│   ├── src/
│   │   ├── main/                  # Electron main process
│   │   │   ├── index.ts           # App entry, window creation
│   │   │   ├── ipc/register.ts    # IPC handlers
│   │   │   ├── agent/task-parser.ts   # LLM planner + regex fallback
│   │   │   ├── llm/call.ts        # Multi-provider LLM client
│   │   │   ├── skills/            # Filesystem + rich file handlers
│   │   │   └── store/             # electron-store persistence
│   │   ├── preload/index.ts       # contextBridge API
│   │   └── renderer/              # React frontend
│   │       ├── App.tsx
│   │       ├── pages/             # Home, Tasks, Workflows, Plugins, Settings
│   │       ├── components/layout/ # TitleBar, Sidebar, StatusBar
│   │       └── styles/            # Design system (dark + light)
│   ├── electron-builder.config.ts
│   └── electron.vite.config.ts
├── package.json
├── LICENSE
└── README.md
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. For architecture details, see [DEVELOPER.md](DEVELOPER.md).

## License

[MIT](LICENSE)
