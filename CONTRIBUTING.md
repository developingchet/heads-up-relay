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

The relay reads the reviewer's private storage, checked against the Claude Code release in
`.github/reviewer-facts.json`. The Upstream releases workflow compares each newer release with that file and
opens an issue when something the relay relies on differs (see Release checks in the README).

A change that moves to a newer release updates, together:

1. the Claude Code version in `.github/ci/package.json` and its lockfile:
   `npm install --prefix .github/ci @anthropic-ai/claude-code@<version>`;
2. the baseline, from that release's Linux build:
   `node scripts/reviewer-facts.mjs .github/ci/node_modules/@anthropic-ai/claude-code-linux-x64/claude --release <version> > .github/reviewer-facts.json`
   (on Windows or macOS, the platform's own build under `.github/ci/node_modules/@anthropic-ai/` gives the
   same facts);
3. the tests' stand-in reviewer, if the layout changed, and the release named in the README.

The ubuntu test job compares the baseline with the pinned build, so a baseline that does not match it fails.

GitHub turns off scheduled workflows in a public repository after 60 days without activity and emails the
owner before it does; re-enable Upstream releases from the Actions tab if that happens.
