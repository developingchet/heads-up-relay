# Contributing

Issues and pull requests are welcome. For security problems, follow [SECURITY.md](SECURITY.md) instead of
opening an issue.

## Making a change

1. Fork the repository and create a branch named for the change, such as `fix/held-note-on-abort`.
2. Run the plugin from your clone with `claude --plugin-dir .`; see [Developing](README.md#developing).
3. Add or update tests in `tests/` for any change in behaviour, then run:

   ```sh
   claude plugin validate .
   claude plugin test .
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
(`hooks/register.ts`). A change that moves to a newer release updates that constant, `CLAUDE_CODE_VERSION` in
`.github/workflows/test.yml`, and the release named in the README together.
