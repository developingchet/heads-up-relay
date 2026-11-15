#!/usr/bin/env node
// Checks each Claude Code release newer than the relay's baseline for a change
// heads-up-relay would feel: the You should know reviewer's storage facts
// (scripts/reviewer-facts.mjs), and the relay's own validation and tests run
// with that release. A release with a change opens one issue, assigned to the
// repository owner; a later release with the same change is added to that
// issue without a new notification, and a closed issue stays closed for it
// until the baseline moves to a newer release.
//
// A release with no change, or a run that cannot reach npm or GitHub, opens
// nothing and does not fail; the next run tries again. A run fails only when it
// found a change and could not open an issue for it.
//
// Environment: GITHUB_REPOSITORY, GITHUB_REPOSITORY_OWNER, GH_TOKEN, and
// optionally REQUESTED (one version to check), RUNNER_TEMP and
// GITHUB_STEP_SUMMARY.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { differences, readFacts } from '../../scripts/reviewer-facts.mjs'

const BASELINE = '.github/reviewer-facts.json'
const PACKAGE = '@anthropic-ai/claude-code'
const BUILD = '@anthropic-ai/claude-code-linux-x64'
const TITLE_END = ' changes what heads-up-relay relies on'
// Outside the plugin folder, so `claude plugin validate .` never sees the build.
const WORK = join(process.env.RUNNER_TEMP || '.', 'upstream-check')
const OUTPUT_CHARS = 4000
// Three runs of the build per release, two releases a run: within the job's 45 minutes.
const BUILD_TIMEOUT_MS = 3 * 60_000
const ATTEMPTS = 3

/** The change recorded when a build cannot be read at all; fixed, so its signature is too. */
export const UNREADABLE = 'facts: this build could not be read, so none of the facts could be checked'

/** The change recorded when the release no longer ships the Linux build this check unpacks. */
export const NO_BUILD = `download: this release has no ${BUILD} with a claude binary, so it could not be checked`

const repo = process.env.GITHUB_REPOSITORY
const owner = process.env.GITHUB_REPOSITORY_OWNER
const requested = process.env.REQUESTED?.trim() || undefined

/** The release could be fetched but has no build to check, which is a change rather than an outage. */
class MissingBuild extends Error {}

const run = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })

const output = result => `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`.trim()
const tail = text => (text.length > OUTPUT_CHARS ? `...${text.slice(-OUTPUT_CHARS)}` : text)

/** Runs a command, throwing with its output when it fails. */
const must = (command, args, options) => {
  const result = run(command, args, options)
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args[0]} exited ${result.status}: ${output(result).slice(-500)}`)
  return result.stdout
}

const retry = async (attempts, action) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action()
    } catch (error) {
      if (attempt === attempts) throw error
      await sleep(attempt * 20_000)
    }
  }
}

/** Text safe to pass as one workflow command's message. */
export const commandText = text => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const warning = text => console.log(`::warning::${commandText(text)}`)
const failure = text => {
  console.log(`::error::${commandText(text)}`)
  process.exitCode = 1
}
const summary = text => {
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
}

/** Whether release `a` comes after release `b`, comparing x.y.z numerically. */
export const isNewer = (a, b) => {
  const parts = version => version.split(/[.-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0)
  const [left, right] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i]
  return false
}

/** Whether `version` looks like a release, so it is safe as a path and a package spec. */
export const isRelease = version => typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)

const versionsToCheck = async checked => {
  if (requested) return [requested]
  const tags = JSON.parse(await retry(ATTEMPTS, () => must('npm', ['view', PACKAGE, 'dist-tags', '--json'])))
  return [...new Set([tags.latest, tags.next].filter(isRelease))].filter(version => isNewer(version, checked))
}

/**
 * Whether a failed download means the release dropped the Linux build. A
 * failure for a build the release still lists is an outage or a publish in
 * progress, not a change; so is a failure to read the release at all.
 */
const dropsBuild = version => {
  try {
    const listed = must('npm', ['view', `${PACKAGE}@${version}`, 'optionalDependencies', '--json']).trim()
    return !(BUILD in (listed ? JSON.parse(listed) : {}))
  } catch {
    return false
  }
}

/** Unpacks the release's Linux build; nothing in the package runs. */
const download = async version => {
  const dir = join(WORK, version)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  try {
    await retry(ATTEMPTS, () => must('npm', ['pack', `${BUILD}@${version}`, '--pack-destination', dir]))
  } catch (error) {
    if (dropsBuild(version)) throw new MissingBuild(`${PACKAGE}@${version} no longer lists ${BUILD}`)
    throw error
  }
  const tarball = readdirSync(dir).find(name => name.endsWith('.tgz'))
  if (tarball === undefined) throw new Error(`npm pack left no tarball for ${BUILD}@${version}`)
  must('tar', ['-xzf', join(dir, tarball), '-C', dir])
  const binary = join(dir, 'package', 'claude')
  if (!existsSync(binary)) throw new MissingBuild(`${BUILD}@${version} has no package/claude`)
  chmodSync(binary, 0o755)
  return binary
}

/** The environment the build runs in: the runner's, without its tokens. */
const buildEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/TOKEN|SECRET|PASSWORD/i.test(name))),
  DISABLE_AUTOUPDATER: '1',
  NO_COLOR: '1',
})

/** The relay's validation and tests with the release; tests get a second run before they count. */
const relayChecks = binary => {
  const options = { env: buildEnv(), timeout: BUILD_TIMEOUT_MS, killSignal: 'SIGKILL' }
  const failed = []
  const validate = run(binary, ['plugin', 'validate', '.'], options)
  if (validate.status !== 0) failed.push({ name: 'claude plugin validate .', output: tail(output(validate)) })
  let tests = run(binary, ['plugin', 'test', '.'], options)
  if (tests.status !== 0) tests = run(binary, ['plugin', 'test', '.'], options)
  if (tests.status !== 0) failed.push({ name: 'claude plugin test . (failed twice)', output: tail(output(tests)) })
  return failed
}

/**
 * Names the change against the baseline release, so the same change in a later
 * release matches the same issue, and moving the baseline starts afresh.
 */
export const signatureOf = (checked, changed, failed) =>
  createHash('sha256')
    .update(JSON.stringify({ checked, changed, failed: failed.map(check => check.name) }))
    .digest('hex')
    .slice(0, 16)

/** The issue body with `version` added to its list of releases, once. */
export const withRelease = (body, version) => {
  const text = body.replace(/\r\n/g, '\n')
  if (text.includes(`\n- ${version}\n`)) return text
  return text.replace(/(### Releases with this change\n\n(?:- .+\n)+)/, `$1- ${version}\n`)
}

/** A code fence longer than any run of backticks in `text`, so the text cannot close it. */
const fenceFor = text => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)))

export const issueBody = (version, checked, changed, failed, signature) => {
  const lines = [
    `Claude Code ${version} changes something heads-up-relay relies on, compared with ${checked}, the release the relay is checked against.`,
    '',
  ]
  if (changed.length > 0) {
    lines.push("### The reviewer's storage", '', ...changed.map(line => `- ${line}`), '')
  }
  for (const check of failed) {
    const fence = fenceFor(check.output)
    lines.push(`### \`${check.name}\` failed`, '', '<details><summary>Output</summary>', '', `${fence}text`, check.output, fence, '', '</details>', '')
  }
  lines.push(
    '### Next steps',
    '',
    '1. Check in a live session on this release whether a note still reaches the conversation.',
    '2. If the relay needs a change, make it, then move the checked release forward as CONTRIBUTING.md describes.',
    '3. If nothing needs to change, close this issue. Later releases with the same change do not open another.',
    '',
    '### Releases with this change',
    '',
    `- ${version}`,
    '',
    `Signature: \`${signature}\``,
  )
  return lines.join('\n')
}

/** Whether the workflow's own token opened the issue; anyone can copy a title and signature. */
export const isOwnIssue = issue =>
  issue.author?.is_bot === true && /^(?:app\/)?github-actions(?:\[bot\])?$/.test(issue.author.login ?? '')

const relayIssues = () =>
  JSON.parse(must('gh', ['issue', 'list', '-R', repo, '--state', 'all', '--limit', '500', '--json', 'number,state,title,body,url,author']))
    .filter(issue => issue.title.endsWith(TITLE_END) && isOwnIssue(issue))

const issueWith = async signature =>
  (await retry(ATTEMPTS, relayIssues)).find(issue => issue.body.includes(`Signature: \`${signature}\``))

/** Opens the issue; a create that failed after GitHub stored it is found, not repeated. */
const createIssue = async (signature, title, file) => {
  for (let attempt = 1; ; attempt++) {
    const result = run('gh', ['issue', 'create', '-R', repo, '--title', title, '--body-file', file])
    if (result.status === 0) return result.stdout.trim()
    const made = await issueWith(signature)
    if (made) return made.url
    if (attempt === ATTEMPTS) throw new Error(`gh issue create exited ${result.status}: ${output(result).slice(-500)}`)
    await sleep(attempt * 20_000)
  }
}

/**
 * Records the change. Only a failed create throws: until the issues can be
 * listed nothing is known to be unrecorded, and an edit adds to an issue the
 * owner already has, so both leave a warning and the next run tries again.
 */
const report = async (version, checked, changed, failed) => {
  const signature = signatureOf(checked, changed, failed)
  let known
  try {
    known = await issueWith(signature)
  } catch (error) {
    warning(`could not list this repository's issues for Claude Code ${version}; the next run tries again (${error.message})`)
    return
  }

  if (known?.state === 'CLOSED') {
    summary(`Claude Code ${version}: the same change as #${known.number}, which is closed; nothing opened.`)
    return
  }
  if (known) {
    const body = withRelease(known.body, version)
    if (body === known.body.replace(/\r\n/g, '\n')) {
      summary(`Claude Code ${version}: the same change as #${known.number}, which already lists it.`)
      return
    }
    const file = join(WORK, `issue-${known.number}.md`)
    writeFileSync(file, body)
    try {
      await retry(ATTEMPTS, () => must('gh', ['issue', 'edit', String(known.number), '-R', repo, '--body-file', file]))
    } catch (error) {
      warning(`could not add Claude Code ${version} to #${known.number}; the next run tries again (${error.message})`)
      return
    }
    summary(`Claude Code ${version}: the same change as #${known.number}; added to that issue without a new notification.`)
    return
  }

  const file = join(WORK, `issue-${version}.md`)
  writeFileSync(file, issueBody(version, checked, changed, failed, signature))
  const url = await createIssue(signature, `Claude Code ${version}${TITLE_END}`, file)
  summary(`Claude Code ${version}: opened ${url}`)
  const assigned = run('gh', ['issue', 'edit', url, '-R', repo, '--add-assignee', owner])
  if (assigned.status !== 0) warning(`could not assign ${url} to ${owner}: ${output(assigned).slice(-300)}`)
}

const factsOf = binary => {
  try {
    return { facts: readFacts(binary) }
  } catch (error) {
    console.log(`reading the build failed: ${error.message}`)
    return { unreadable: true }
  }
}

/** What changed in the release, or undefined when it could not be fetched this time. */
const changesIn = async (version, baseline) => {
  let binary
  try {
    binary = await download(version)
  } catch (error) {
    if (error instanceof MissingBuild) {
      console.log(error.message)
      return { changed: [NO_BUILD], failed: [] }
    }
    warning(`could not download Claude Code ${version}; the next run tries again (${error.message})`)
    return undefined
  }
  try {
    const read = factsOf(binary)
    return {
      changed: read.unreadable ? [UNREADABLE] : differences(baseline.facts, read.facts),
      failed: relayChecks(binary),
    }
  } finally {
    rmSync(join(WORK, version), { recursive: true, force: true })
  }
}

const check = async (version, baseline) => {
  const found = await changesIn(version, baseline)
  if (found === undefined) return
  const { changed, failed } = found
  if (changed.length === 0 && failed.length === 0) {
    summary(`Claude Code ${version}: nothing the relay relies on changed; validation and tests pass.`)
    return
  }
  try {
    await report(version, baseline.release, changed, failed)
  } catch (error) {
    failure(`Claude Code ${version} changes what the relay relies on, and recording it on GitHub failed: ${error.message}\n${changed.join('\n')}`)
  }
}

const main = async () => {
  if (requested !== undefined && !isRelease(requested)) {
    failure(`not a Claude Code release: ${JSON.stringify(requested)}`)
    return
  }
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
  mkdirSync(WORK, { recursive: true })
  let versions
  try {
    versions = await versionsToCheck(baseline.release)
  } catch (error) {
    warning(`could not read Claude Code's releases from npm; the next run tries again (${error.message})`)
    return
  }
  if (versions.length === 0) summary(`No Claude Code release newer than ${baseline.release}.`)
  for (const version of versions) await check(version, baseline)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
