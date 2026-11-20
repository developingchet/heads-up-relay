# Changelog

## 0.0.6 - 2026-11-20

- Checked against Claude Code 2.1.329, which CI now runs and the release baseline is read from.
- Escapes `<terminal …>` and `</terminal>`. 2.1.329 reads a user message wrapped in
  `<terminal name="…">` as a terminal selection the person attached, so a note could pass text off as one.
- With `CLAUDE_CODE_YOU_SHOULD_KNOW_AUTO_SEND` on, the reviewer now writes `Sent a note to Claude with your
  prompt` to the transcript when it sends the note on the band with the person's prompt. The relay takes a
  forwarded note off the band, so that line appears only for a note the relay did not forward.
- The README's account of when the reviewer is offered names its second data-retention check and that it
  waits for its compliance check to settle.
- The closing tags `list`, `log`, `person` and `record` that 2.1.328 added belong to a side model's prompt
  built from the person's own messages, which leaves out appended rows such as the relay's, so they stay
  unescaped and join the baseline.

## 0.0.5 - 2026-11-20

- `receipt: expanded` cuts each note at 8,000 characters instead of not at all. Without a cut, one long note
  stayed in the conversation for every later request, and a note with a long run of joiners after a letter
  outside ASCII held up the session for seconds while it was cleaned. The `/config` description now says the
  setting raises the cut for the copy Claude reads, not only the transcript's.
- Dropping a run of joiners or variation selectors after ASCII takes time in proportion to the run, not its
  square.
- The fence is sized without passing every backtick run to `Math.max` as an argument, which failed with
  `Maximum call stack size exceeded` on an uncut note with hundreds of thousands of them and left it on the
  band.
- `log` mode follows `receipt` too: each note it writes is cut at 1,500 characters, or 8,000 with
  `expanded`, the same as a held note it shows when the relay loads.
- A held note shown in the transcript because its append missed the deadline is not written out a second
  time when the append is stored after all; the late receipt line names it.

## 0.0.4 - 2026-11-19

- New `receipt` option, set in `/config` or `pluginConfigs`: `summary` (the default) keeps the transcript to
  one line naming each note relayed; `expanded` follows that line with the whole note, explanation included,
  each line marked `│ `.
- With `receipt: expanded` the 1,500-character cut is lifted — for the appended row, the transcript copy
  after its receipt line, and a note shown in the transcript because it could not be appended — so the
  transcript carries the same text the main agent read, before the model's copy is fenced and its
  envelope-like tags escaped. An unreadable value falls back to `summary`.

## 0.0.3 - 2026-11-16

- Escapes a tag whose name has joiners or variation selectors after a letter outside ASCII, such as
  `<𝐮` + U+FE0F + `ser>`, which reads as `<user>`, however long the runs of them are.
- The fuzz tests spell protected names with such runs, allow space only between a tag's bracket and its
  name, as a tag does, and keep these cases as fixed tests.
- The release zip leaves out the tests and CI files with `git archive` pathspecs instead of
  `export-ignore`, so GitHub's source archives, which OpenSSF Scorecard reads, include the workflows again.

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
