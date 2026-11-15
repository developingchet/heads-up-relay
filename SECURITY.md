# Security Policy

## Supported versions

Only the latest release on `main` receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through [GitHub private vulnerability reporting](https://github.com/developingchet/heads-up-relay/security/advisories/new) (the **Security** tab, then **Report a vulnerability**).

Please include:
- the heads-up-relay version and the Claude Code version (`claude --version`)
- the `mode` it ran in, and how it was loaded (installed or `--plugin-dir`)
- steps to reproduce, and the impact you expect

GitHub keeps the report confidential until a fix is released.

## Response timeline

- Acknowledgement within 3 business days.
- A status update within 7 business days.
- A fix within 30 days of a confirmed reproduction. Critical issues (CVSS 9.0 or higher) are expedited on a best-effort basis.

Disclosure is coordinated with the reporter, who is credited unless they prefer otherwise.

## Scope

In scope:
- note text that closes the fence, drops or rewrites the framing around it, or opens or closes a tag the relay is meant to escape
- characters that survive cleaning and hide or disguise text in what the main agent reads or the transcript shows
- a transcript line, warning or status line written from reviewer text that can pass for one the relay wrote
- the relay acting on a store write from anything other than the built-in reviewer at the built-in tier
- a note reaching a session other than the one the reviewer showed it in

Out of scope:
- what the reviewer chooses to say, and how the main agent weighs a correctly framed note
- problems in Claude Code, the built-in reviewer or the models themselves (report those to Anthropic)
- a session where an organization's policy, `--safe-mode` or a missing reviewer keeps the relay from running
