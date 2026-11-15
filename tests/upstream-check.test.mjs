// Tests for .github/scripts/upstream-check.mjs: which releases it checks, and
// how it keeps one issue per change.
//
//   node --test tests/upstream-check.test.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { commandText, isNewer, isOwnIssue, isRelease, issueBody, signatureOf, withRelease } from '../.github/scripts/upstream-check.mjs'

test('only release versions are checked', () => {
  for (const version of ['2.1.325', '2.2.0-beta.1', '10.0.0']) assert.equal(isRelease(version), true, version)
  for (const version of ['', 'latest', '2.1', '../2.1.325', '2.1.325/x', '--help', '2.1.325 ', undefined]) {
    assert.equal(isRelease(version), false, String(version))
  }
})

test('only releases after the baseline are newer', () => {
  assert.equal(isNewer('2.1.326', '2.1.325'), true)
  assert.equal(isNewer('2.2.0', '2.1.999'), true)
  assert.equal(isNewer('2.1.325', '2.1.325'), false)
  assert.equal(isNewer('2.1.311', '2.1.325'), false)
  assert.equal(isNewer('2.1.30', '2.1.299'), false)
})

test('the same change against the same baseline has the same signature', () => {
  const changed = ['viewKeys: ["line"] in the baseline, ["text"] in this build']
  const failed = [{ name: 'claude plugin test . (failed twice)', output: 'run one' }]
  assert.equal(signatureOf('2.1.325', changed, failed), signatureOf('2.1.325', changed, [{ ...failed[0], output: 'run two' }]))
  assert.notEqual(signatureOf('2.1.325', changed, failed), signatureOf('2.1.325', changed, []))
  assert.notEqual(signatureOf('2.1.325', changed, []), signatureOf('2.1.325', ['storeKeys: changed'], []))
  assert.notEqual(signatureOf('2.1.325', [], failed), signatureOf('2.1.330', [], failed))
})

test('a later release is added to the issue once, and nothing else changes', () => {
  const body = issueBody('2.1.326', '2.1.325', ['storeKeys: changed'], [], 'abc')
  const once = withRelease(body, '2.1.327')
  assert.match(once, /### Releases with this change\n\n- 2\.1\.326\n- 2\.1\.327\n\nSignature: `abc`$/)
  assert.equal(withRelease(once, '2.1.327'), once)
  assert.equal(withRelease(once, '2.1.326'), once)
  assert.equal(once.replace('- 2.1.327\n', ''), body)
})

test('a body saved with CRLF line endings still takes the release', () => {
  const body = issueBody('2.1.326', '2.1.325', ['storeKeys: changed'], [], 'abc').replace(/\n/g, '\r\n')
  assert.match(withRelease(body, '2.1.327'), /- 2\.1\.326\n- 2\.1\.327\n/)
})

test('the issue body names each change and failed check', () => {
  const body = issueBody('2.1.326', '2.1.325', ['entryKeys: changed'], [{ name: 'claude plugin validate .', output: 'error: x' }], 'sig')
  assert.match(body, /compared with 2\.1\.325/)
  assert.match(body, /- entryKeys: changed/)
  assert.match(body, /### `claude plugin validate \.` failed/)
  assert.match(body, /error: x/)
  assert.match(body, /Signature: `sig`$/)
})

test('check output cannot close its code fence', () => {
  const body = issueBody('2.1.326', '2.1.325', [], [{ name: 'claude plugin test .', output: 'a\n```\n@someone\n````' }], 'sig')
  assert.match(body, /\n`````text\na\n```\n@someone\n````\n`````\n/)
})

test('only issues the workflow opened are matched', () => {
  assert.equal(isOwnIssue({ author: { is_bot: true, login: 'app/github-actions' } }), true)
  assert.equal(isOwnIssue({ author: { is_bot: true, login: 'github-actions[bot]' } }), true)
  assert.equal(isOwnIssue({ author: { is_bot: false, login: 'github-actions' } }), false)
  assert.equal(isOwnIssue({ author: { is_bot: true, login: 'app/github-actions-helper' } }), false)
  assert.equal(isOwnIssue({}), false)
})

test('workflow command text stays on one line', () => {
  assert.equal(commandText('50% done\r\nnext'), '50%25 done%0D%0Anext')
})

test('the baseline names the release CI is pinned to', () => {
  const baseline = JSON.parse(readFileSync(new URL('../.github/reviewer-facts.json', import.meta.url), 'utf8'))
  const ci = JSON.parse(readFileSync(new URL('../.github/ci/package.json', import.meta.url), 'utf8'))
  assert.equal(baseline.release, ci.dependencies['@anthropic-ai/claude-code'])
})
