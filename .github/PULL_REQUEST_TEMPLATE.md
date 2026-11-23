## Summary

<!-- What does this change and why? Link the issue it closes. -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New behaviour
- [ ] Docs
- [ ] Refactor, tests or CI

## Testing

- [ ] `claude plugin validate --strict .`
- [ ] `claude plugin test .`
- [ ] `node --test tests/note.fuzz.js tests/reviewer-facts.test.mjs tests/upstream-check.test.mjs` (for changes to note cleaning, reviewer facts or the release check)
- [ ] Checked in a live session with the reviewer running (if relay behaviour changed)
- [ ] CI passes

Tests not run, and why:

<!-- List skipped checks and the reason, for example a missing reviewer entitlement. -->

## Compatibility

<!-- Effects on delivery modes, options, the pinned Claude Code release, stored notes or the transcript format. Write "none" when there is no user-visible change. -->

## Rollback

<!-- How to return to the previous release, including saved options and pinned installs. -->

## Checklist

- [ ] Tests added or updated for behaviour changes
- [ ] README and `CHANGELOG.md` updated if needed
- [ ] No secrets, notes from real sessions or other private data in code, tests or logs
- [ ] Security and privacy impact considered; no real session notes, transcripts or private text in code, tests or examples
