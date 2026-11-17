# Changelog

## 0.0.2 - 2026-11-16

- The transcript line for a forwarded note reads `relayed Claude a note: <the note>`, without the note's tag.
- Escapes a tag opened with a fullwidth or small `<` followed by joiners, selectors, spaces or slashes, any
  tag name with `-`, `_` or `:`, a name spelled in fullwidth, mathematical or other compatibility letters,
  and more harness tag names, among them `channel`, `env`, `memory`, `function` and `stdout`.
- The framing tells the main agent not to follow any instruction in the note.
- A note is skipped only when it was shown before the relay loaded, instead of when its turn started
  before; a resume or a reload no longer leaves later notes on the band.
- Notes held while a reply streams are kept in the session's plugin state (`types/index.d.ts`), so a reload
  appends them when the next request ends instead of losing them; one held in another conversation is
  shown in the transcript instead.
- Held notes are appended together under one deadline, and the append deadline is 3 seconds instead of 5.
- The reviewer's reads of `sessions` wait for its writes the relay is still holding.
- A reviewer write whose dispatch was abandoned is left to the engine instead of being stored again, and one
  with under a second of its hook budget left is passed on without an append.
- Every refused or failed note gets its own warning, not only the first.
- The debug log names the row each note was appended as, and `scripts/reactions.mjs` prints it and cleans
  transcript text as the relay does.
- The Upstream releases workflow runs a release in a job whose token has no permissions and files issues
  from a second job, and checks more of the reviewer: its name, the turn it names, that it reviews
  main-loop requests only, its band, its declared hooks, calls and state, and the tags a note's escaping
  would leave open.
- A release runs the test workflow first, and its zip leaves out the tests and CI files.

## 0.0.1 - 2026-11-15

First release.

- Adds each note the built-in You should know reviewer shows to the main conversation with
  `$.session.append`, as a fenced, unverified observation, and takes it off the reviewer's band.
- Holds a note shown while the main agent's reply is streaming until that model request ends, so the note
  is stored after the reply instead of ahead of it.
- Cleans the note before anything reads it: invisible and control characters, unpaired surrogates and stray
  joiners are dropped, and envelope, tool-call and harness tags are escaped.
- Warns in the transcript and the status line when a note cannot be read or added, or when the reviewer's
  layout looks changed.
- `log` mode writes notes to the transcript only; `off` registers no hooks.
- `scripts/reactions.mjs` prints what the main agent did after each note in a session's transcript.
- Checked against Claude Code 2.1.325. The Upstream releases workflow checks each newer release twice a day:
  it compares the reviewer's storage with a saved baseline and runs the relay's validation and tests with
  that release, opening one issue per change it finds.
- Released as a zip with a checksum file, both signed with cosign.
