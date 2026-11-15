# Contributing

Issues and pull requests are welcome. For security problems, follow [SECURITY.md](SECURITY.md) instead of
opening an issue.

## Making a change

1. Fork the repository and create a branch named for the change, such as `fix/held-note-on-abort`.
2. Run the plugin from your clone with `claude --plugin-dir .`; see [Developing](README.md#developing).
3. Add or update tests in `tests/` for any change in behaviour, then run:

   ```sh
   claude plugin validate --strict .
   claude plugin test .
   ```

   A change to `hooks/note.ts` also runs the property-based tests, with Node 24 or later:

   ```sh
   npm ci --prefix tests
   node --test tests/note.fuzz.mjs
   ```

4. A change to how notes are read, held or appended also needs a check in a live session where the You should
   know reviewer runs; say in the pull request what you saw.
5. Update `README.md` and `CHANGELOG.md` when behaviour or options change.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): a short subject such as
`fix: hold notes shown while a reply streams`, and a body that explains what changed and why. Pull requests are
squash-merged, so the pull request title becomes the commit subject on `main`.

## Compatibility

The relay reads the reviewer's private storage, checked against the Claude Code release in `CHECKED_RELEASE`
(`hooks/register.ts`). A change that moves to a newer release updates that constant, the Claude Code version
in `.github/ci/package.json` and its lockfile (`npm install --prefix .github/ci @anthropic-ai/claude-code@<version>`),
and the release named in the README together. The weekly Reviewer layout workflow fails when the newest
release no longer contains the layout the relay reads.
