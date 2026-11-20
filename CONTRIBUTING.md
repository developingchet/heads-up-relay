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

   A change to `hooks/note.ts`, `scripts/reviewer-facts.mjs` or the release check also runs the Node tests,
   with Node 24 or later:

   ```sh
   npm ci --prefix tests
   node --test tests/note.fuzz.js tests/reviewer-facts.test.mjs tests/upstream-check.test.mjs
   ```

4. A change to how notes are read, held or appended also needs a check in a live session where the You should
   know reviewer runs; say in the pull request what you saw. The test kit cannot show these, so check the
   ones the change touches:

   - a note shown while Claude runs a tool (a long `sleep` will do): its row must not come between the tool
     call and its result, the next request must go through, and the note leaves the band;
   - a note shown while a subagent runs: the same, with the row outside the subagent's own transcript and
     not between the call that started the subagent and its reply;
   - a note held while a reply streams, then `/reload-plugins` before the reply ends: the note is appended
     when the next request ends, or shown in the transcript with `mode: log`.

   `node scripts/reactions.mjs <session id>` lists the rows the relay appended, and the debug log
   (`claude --debug`) names each one's uuid.
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
2. the baseline, from that release's Linux and Windows builds. The reviewer's facts are the same in both,
   but `unescapedClosingTags` is not: each platform's build bundles its own native code and prompts, so
   each lists closing tags the other lacks. The baseline holds the union, and the script refuses builds
   that disagree on any other fact. Unpack both builds outside the repository, then pass both:

   ```sh
   npm pack @anthropic-ai/claude-code-linux-x64@<version> @anthropic-ai/claude-code-win32-x64@<version> --pack-destination <dir>
   # extract each tarball into its own folder under <dir>, then:
   node scripts/reviewer-facts.mjs <dir>/linux/package/claude <dir>/win32/package/claude.exe --release <version> > .github/reviewer-facts.json
   ```

   Each build must then compare equal on its own:
   `node scripts/reviewer-facts.mjs <build> --baseline .github/reviewer-facts.json` exits 0;
3. the tests' stand-in reviewer, if the layout changed, and the release named in the README.

The ubuntu test job compares the baseline with the pinned Linux build, so a baseline that does not match it
fails. A tag that only one platform's build closes is still listed, so the comparison passes on either.

GitHub turns off scheduled workflows in a public repository after 60 days without activity and emails the
owner before it does; re-enable Upstream releases from the Actions tab if that happens.
