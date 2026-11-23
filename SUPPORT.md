# Support

## Usage questions and setup help

Start with [Before you install](README.md#before-you-install), [Nothing arrives](README.md#nothing-arrives) and [Known limits](README.md#known-limits) in the README. If those do not answer the question, open a [Question / Support issue](https://github.com/developingchet/heads-up-relay/issues/new?template=question.yml) with the plugin version, the Claude Code version, the operating system, the `mode` and `receipt` in use, and what has already been tried.

Notes and transcripts can quote your code and conversation. Remove anything private before pasting them into an issue, a log or a debug file. The relay marks its own rows with `heads-up-relay:`; do not paste an unedited session transcript.

## Bugs and feature requests

Use the [Bug report](https://github.com/developingchet/heads-up-relay/issues/new?template=bug_report.yml) form for wrong behaviour and the [Feature request](https://github.com/developingchet/heads-up-relay/issues/new?template=feature_request.yml) form for proposed changes. Issue forms are the public intake; this repository does not use GitHub Discussions.

## Security reports

Do not report a vulnerability in a public issue. Use [private vulnerability reporting](https://github.com/developingchet/heads-up-relay/security/advisories/new) and follow [SECURITY.md](SECURITY.md) for scope, reproduction limits and response targets.

## Claude Code or the built-in reviewer

Problems in Claude Code itself, the built-in You should know reviewer's availability, or what the reviewer chooses to say belong upstream at [anthropics/claude-code](https://github.com/anthropics/claude-code/issues). The relay only observes and relays notes it did not write; see [SECURITY.md](SECURITY.md#scope) for the boundary.

## Responses

Issues are reviewed as time allows. Include the output of `claude --version` and `claude plugin list` so a question can be answered without a second round of requests. A passing test kit does not prove that notes arrive; only a live session with the built-in reviewer running shows that.
