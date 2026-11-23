# AGENTS.md

heads-up-relay is a Claude Code plugin that relays the built-in You should know reviewer's notes into the main conversation as unverified context. It adds no review and no model calls. The built-in reviewer is not available to every account, so a live check needs an entitled interactive session.

## Layout

| Path | Contents |
|---|---|
| `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | Plugin manifest, marketplace entry and the `mode` and `receipt` user options |
| `hooks/register.ts`, `hooks/note.ts`, `hooks/hooks.json` | Hook registration, note cleaning and framing, and the module list |
| `types/index.d.ts`, `tsconfig.json` | Types for the generated Claude Code API; `.claude-plugin/types/` is generated and ignored |
| `scripts/reactions.mjs` | Reads a local `.jsonl` transcript and prints each relayed note followed by what the main agent did next |
| `scripts/reviewer-facts.mjs`, `.github/reviewer-facts.json` | Reads a Claude Code build and holds the pinned reviewer-storage baseline |
| `.github/scripts/upstream-check.mjs` | Checks newer Claude Code releases and opens an issue when a relied-on fact changes |
| `tests/` | Property-based and unit tests for note cleaning, the baseline script and the upstream check |
| `.github/workflows/` | Test, release, Scorecard and upstream-release checks |

## Working on the plugin

Node 24 or later and Claude Code 2.1.287 or later are the documented toolchain. The CI baseline is pinned to Claude Code 2.1.329 in `.github/ci/package.json` and `.github/reviewer-facts.json`.

```sh
claude --plugin-dir .
claude plugin validate --strict .
claude plugin test .
npm ci --prefix tests
node --test tests/note.fuzz.js tests/reviewer-facts.test.mjs tests/upstream-check.test.mjs
node scripts/reviewer-facts.mjs <build> --baseline .github/reviewer-facts.json
node scripts/reactions.mjs <session id or path to its .jsonl>
```

The first interactive `claude --plugin-dir .` writes `.claude-plugin/types/`, which `tsconfig.json` extends. Without it an editor or `tsc -p .` reports a missing file. The Node tests need `npm ci --prefix tests`; they make no network calls once the dependencies are present.

## Conventions

- Commits follow Conventional Commits and pull requests are squash-merged, so the PR title becomes the commit subject on `main`.
- A change to `hooks/note.ts`, `scripts/reviewer-facts.mjs` or the release check also runs the Node tests. A change to how notes are read, held or appended needs a live session check with the built-in reviewer running, as `CONTRIBUTING.md` describes.
- Move the checked Claude Code release forward only with the Linux and Windows builds: update `.github/ci/package.json` and its lockfile, regenerate `.github/reviewer-facts.json` from both builds, and update the release named in the README. The baseline holds the union of the two builds.
- Update `README.md` and `CHANGELOG.md` when behaviour or options change. Documentation-only changes do not need a changelog entry.
- `SECURITY.md` is the intake for vulnerabilities. Keep exploit details out of public issues and pull requests.

## Boundaries

The relay reads the reviewer's private storage and treats its text as untrusted. Keep the escaping and framing in `hooks/note.ts` intact, and do not commit real session transcripts, reviewer notes, debug logs with conversation text, API keys or generated types.

A test-kit run, a plugin install or a `claude -p` session does not prove that notes still arrive. Reviewer eligibility, a real reviewer note, the transcript marker and the next-request behaviour need a live interactive session.

Local agent instruction files, `node_modules/`, `.claude-plugin/types/`, `upstream-check/` and `*.log` are not committed.
