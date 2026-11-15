# Changelog

## 0.0.1 - 2026-11-14

First release.

- Adds each note the built-in You should know reviewer shows to the main conversation with
  `$.session.append`, as a fenced, unverified observation, and takes it off the reviewer's band.
- Holds a note shown while the main agent's reply is streaming until that model request ends, so the note
  is stored after the reply instead of ahead of it.
- Cleans the note before anything reads it: invisible and control characters, unpaired surrogates and stray
  joiners are dropped, and envelope, tool-call and harness tags are escaped.
- Warns in the transcript and the status line when a note cannot be read or added, or when the reviewer's
  layout looks changed; reminds once on a Claude Code release other than the one it was checked against
  (2.1.325).
- `log` mode writes notes to the transcript only; `off` registers no hooks.
- `scripts/reactions.mjs` prints what the main agent did after each note in a session's transcript.
