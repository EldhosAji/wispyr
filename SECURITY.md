# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in Wispyr, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please open a **private security advisory** on the GitHub repository, or contact the repository owner directly via GitHub. Include:

1. A description of the vulnerability
2. Steps to reproduce the issue
3. The potential impact
4. Any suggested fixes (optional)

### What to Expect

- **Acknowledgement** within 48 hours of your report
- **Status update** within 7 days with an assessment and timeline
- **Fix or mitigation** as soon as possible, depending on severity
- **Credit** in the release notes (unless you prefer to remain anonymous)

## Security Best Practices for Users

- **Never commit API keys** to the repository. Wispyr stores provider credentials in your local app data directory, not in the project.
- **Review AI-generated plans** before approving execution. Always inspect what actions will be taken.
- **Keep dependencies updated** by running `npm audit` regularly.
- **Use the permission system** -- Wispyr enforces 4 permission levels (READ, WRITE, DESTRUCTIVE, SYSTEM) for a reason.

## Security Design Principles

- All file operations are scoped to the user-selected working directory
- LLM output is parsed as structured JSON, never executed via `eval()`
- No HTTP or WebSocket servers are opened by the application
- Destructive operations require explicit per-action user approval
- API keys are stored in the OS app data directory, not in the project tree
