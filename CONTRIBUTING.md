# Contributing to Wispyr

Thank you for your interest in contributing to Wispyr! This document provides guidelines and information for contributors.

---

## Code of Conduct

Be respectful, constructive, and inclusive. We welcome contributors of all experience levels.

---

## How to Contribute

### Reporting Issues

- Check existing issues before creating a new one
- Include: steps to reproduce, expected vs actual behaviour, OS version, Node version, Electron version
- Include screenshots or screen recordings when possible
- For LLM-related issues, mention which provider and model you're using

### Suggesting Features

- Open a discussion or issue with the `feature` label
- Describe the use case, not just the solution
- Reference the roadmap phases (see below) to see if it's already planned

### Submitting Code

1. **Fork** the repository
2. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes** (see guidelines below)
4. **Test** your changes:
   ```bash
   cd apps/desktop
   npm install
   cd ../..
   npm run dev     # Manual testing
   npm run build   # Verify build
   ```
5. **Commit** with a clear message:
   ```
   feat: add Google Sheets export support
   fix: handle special characters in filenames
   docs: update provider setup instructions
   ```
6. **Push** and open a **Pull Request**

---

## Development Guidelines

### Code Style

- **TypeScript** everywhere (strict mode)
- **No `any` in public interfaces** -- use proper types. `any` is acceptable in internal plumbing where the LLM returns dynamic JSON.
- **Descriptive function names** -- `writeExcel`, not `we` or `handleIt`
- **No unnecessary abstractions** -- three lines of clear code beats a premature helper function
- **Comments only where non-obvious** -- the code should be self-documenting

### Architecture Rules

- **Main process only** for file operations, LLM calls, and store access
- **Renderer never imports from main** -- all communication goes through the `contextBridge` preload API
- **No open ports** -- no HTTP servers, no WebSocket servers
- **Skills are synchronous or Promise-based** -- no callbacks
- **Lazy initialization** for `electron-store` instances -- never create `new Store()` at module scope

### File Naming

```
feature-name.ts          # modules (kebab-case)
FeatureName.tsx          # React components (PascalCase)
feature.store.ts         # store modules
feature.skill.ts         # skill modules
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat:     New feature
fix:      Bug fix
docs:     Documentation
style:    Code style (formatting, no logic change)
refactor: Code change that neither fixes a bug nor adds a feature
test:     Adding or updating tests
chore:    Build process, dependencies, tooling
```

---

## What to Work On

### Good First Issues

- Add input validation to the provider form (URL format, non-empty name)
- Add keyboard shortcuts (Ctrl+Enter to submit task, Escape to cancel plan)
- Add a "Clear task history" button in Settings
- Improve error messages shown to the user
- Add loading states for provider test connection

### Medium Effort

- **New file type handlers** -- add support for `.ics` (calendar), `.vcf` (contacts), `.svg` (images)
- **Streaming LLM responses** -- show tokens as they arrive instead of waiting for full response
- **Multi-turn context** -- remember previous tasks in the session for follow-up questions
- **WISPYR.md support** -- read a context file from the working folder (per the spec)
- **Workflow runner** -- actually execute saved workflow templates step by step
- **Dark/light theme toggle** -- add explicit toggle in Settings (currently system-only)

### Larger Features (Roadmap Phases)

| Phase | Feature | Status |
|-------|---------|--------|
| 2 | LLM tool calling (function calling API) | Not started |
| 3 | WISPYR.md session context | Not started |
| 4 | Full permission system with session memory | Partial |
| 5 | Enhanced filesystem skill | Done |
| 6 | Browser skill (Playwright) | Not started |
| 7 | Desktop computer use (nut-tree/nut-js) | Not started |
| 8 | Scheduler + Shell skills | Not started |
| 9 | Workflow template runner | Partial (CRUD done) |
| 10 | Plugin system + MCP bridge | Not started |
| 11 | First-run wizard + onboarding | Not started |

---

## Adding a New LLM Provider

See [DEVELOPER.md](DEVELOPER.md#adding-a-new-llm-provider) for step-by-step instructions. Providers are self-contained -- each has its own request builder, response parser, and auth mechanism.

## Adding a New File Type

See [DEVELOPER.md](DEVELOPER.md#adding-a-new-file-type) for the process. The key is updating both the file handler module and the LLM system prompt so the AI knows the correct JSON schema.

## Adding a New Skill

See [DEVELOPER.md](DEVELOPER.md#adding-a-new-skill) for the pattern. Skills are functions that take parameters and return `{ success, log, result, error }`.

---

## Pull Request Checklist

Before submitting your PR, verify:

- [ ] `npm run build` succeeds with no errors
- [ ] `npm run dev` launches the app without crashes
- [ ] Your feature works with at least one LLM provider (or with the fallback parser if no LLM)
- [ ] No hardcoded API keys, tokens, or secrets
- [ ] No `console.log` left in renderer code (main process logs are OK for debugging)
- [ ] New file types are documented in the LLM system prompt (`task-parser.ts`)
- [ ] Commit messages follow conventional commits format

---

## Security

- **Never commit API keys** -- they are stored in `%APPDATA%` at runtime, not in the repo
- **File operations are scoped** -- skills should only operate within the user-selected working folder
- **Permission levels matter** -- destructive actions must require per-call approval
- **Sanitize LLM output** -- the LLM generates JSON plans that are parsed; never `eval()` LLM output

---

## Questions?

- Open an issue with the `question` label
- Check [DEVELOPER.md](DEVELOPER.md) for architecture details
- Check [README.md](README.md) for usage instructions

---

## License

By contributing to Wispyr, you agree that your contributions will be licensed under the MIT License.
