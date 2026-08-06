# Security Policy

## Supported versions

This project is distributed by cloning the repository, so only the latest commit
on `main` is supported. Please update your checkout before reporting an issue.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report them privately through GitHub's
[private vulnerability reporting](https://github.com/ahaitota/test-results-canvas/security/advisories/new)
on this repository. That opens a draft advisory visible only to you and the
maintainers.

Please include:

- the type of issue (for example XSS, path traversal, SSRF, command injection),
- the source files involved and, if you can, the affected line numbers,
- any special configuration needed to reproduce,
- step-by-step reproduction instructions, ideally with a proof-of-concept
  report file,
- what an attacker could achieve by exploiting it.

You can expect an initial response within 7 days. If the issue is confirmed, a
fix will be pushed to `main` and credited in the advisory unless you ask
otherwise.

## Scope

This extension runs inside the GitHub Copilot app and serves a local UI panel
over HTTP/SSE. The security-relevant surfaces are:

- **Untrusted report content.** Test names, class names and failure messages
  come from `.trx` and JUnit XML files that the extension did not produce. They
  are treated as attacker-controlled and escaped before rendering.
- **Agent-supplied input.** Values arriving at the canvas open and action
  boundary are narrowed in `src/validate.ts` before use.
- **The local HTTP/SSE server.** It binds to loopback and gates the agent-facing
  endpoint on a per-instance secret.

Findings in any of these areas are in scope. Reports that require an attacker to
already have local code execution as the user, or that depend on the user
deliberately opening a malicious file they authored themselves, are generally
out of scope — but if you are unsure, report it and let us decide.
