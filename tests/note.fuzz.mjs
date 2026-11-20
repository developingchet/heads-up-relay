// Property-based tests for the text the relay passes on. Random notes, biased
// toward the characters and tags an injected note would use, must never close
// the fence, keep an invisible or control character, open a protected tag, or
// pass a transcript line off as the relay's own.
//
// Run with Node 24 or later, which loads hooks/note.ts directly:
//   npm ci --prefix tests && node --test tests/note.fuzz.mjs

import assert from 'node:assert/strict'
import { test } from 'node:test'
import fc from 'fast-check'
import {
  EXPANDED_NOTE_CHARS,
  MAX_NOTE_CHARS,
  ONE_LINE_CHARS,
  cleanText,
  contextText,
  fencedNote,
  oneLine,
  transcriptText,
} from '../hooks/note.ts'

const RUNS = { numRuns: 3000 }
const cp = (...points) => String.fromCodePoint(...points)

// Pieces an attacker would reach for: tag openers in three widths, envelope
// and tool-call names, backtick runs, joiners and selectors, bidi controls,
// tag-block characters, noncharacters, lone surrogates, separators and an
// escape sequence.
const TOKENS = [
  '<', '</', '< /', cp(0xff1c), cp(0xfe64), '>',
  'system-reminder', 'system_prompt', 'user', 'User', 'assistant', 'human', 'function_calls',
  'invoke', 'parameter', 'task-notification', 'local-command-stdout', 'tool_result', 'antml:invoke',
  'channel', 'claude_md', 'cross-session-message', 'env', 'memory', 'stdout', 'function', '/', cp(0xff0f),
  cp(0xff53), cp(0xff59), cp(0xff53, 0xff54, 0xff45, 0xff4d), cp(0x1d42c), cp(0x1d42e), 'ystem', 'ser', cp(0xff3f),
  '`', '``', '```', '````', '~~~',
  cp(0x200b), cp(0x200c), cp(0x200d), cp(0xfe0e), cp(0xfe0f), cp(0x20e3), cp(0xfeff),
  cp(0x202e), cp(0x2066), cp(0x200f), cp(0x061c), cp(0xe0041), cp(0xe007f), cp(0x3164),
  cp(0xfffe), cp(0xffff), String.fromCharCode(0xd800), String.fromCharCode(0xdc00),
  '\n', '\r\n', '\r', cp(0x2028), cp(0x2029), '\t', cp(0x1b) + '[31m', cp(0x7f),
  '1', 'a', ' ', '·', cp(0x1f600), cp(0x1f469, 0x200d, 0x1f4bb),
]

const text = fc
  .array(
    fc.oneof(
      { weight: 3, arbitrary: fc.constantFrom(...TOKENS) },
      { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 30 }) },
    ),
    { maxLength: 80 },
  )
  .map(parts => parts.join(''))

const note = fc.record({
  line: text,
  tag: fc.oneof(fc.constant('Heads up'), text),
  explanation: text,
}).map(fields => ({ ...fields, isTagged: true, shownAt: 0, reviewedTurn: undefined }))

const longestBacktickRun = value => Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length))

// Control characters other than tab and newline, bidi and other format
// characters, default-ignorables, the tag block, noncharacters U+FFFE/U+FFFF.
const FORBIDDEN = new RegExp(`(?![\\t\\n${cp(0x200c)}${cp(0x200d)}${cp(0xfe0e)}${cp(0xfe0f)}])[\\p{Cc}\\p{Cf}\\p{Default_Ignorable_Code_Point}${cp(0xfffe)}${cp(0xffff)}${cp(0x2028)}${cp(0x2029)}\\r]`, 'u')
const LINE_BREAK = new RegExp(`[\\n\\r${cp(0x2028)}${cp(0x2029)}]`)

// Tag names the note must never open or close, listed rather than read from
// the relay's rule, so a rule that stops covering one fails here.
const PROTECTED_NAMES = [
  'system-reminder', 'system_prompt', 'system', 'user', 'human', 'assistant', 'function_calls', 'invoke',
  'parameter', 'task-notification', 'local-command-stdout', 'tool_result', 'antml:invoke', 'channel',
  'claude_md', 'cross-session-message', 'env', 'memory', 'stdout', 'function', 'terminal',
]

// What hides nothing in a tag: the note is read in NFKC form, so compatibility
// letters read as the name they spell; joiners and selectors are dropped
// wherever they stand, and any space or slashes may stand between the bracket
// and the name. Space inside a name ends it, as it does for a tag.
const FILLER = new RegExp(`[${cp(0x200c)}${cp(0x200d)}${cp(0xfe0e)}${cp(0xfe0f)}]`, 'gu')
const PROTECTED = new RegExp(
  `[<${cp(0xff1c)}${cp(0xfe64)}][\\s/]*(?:${PROTECTED_NAMES.join('|')})(?![a-z0-9])`,
  'i',
)

const FIRST_LINE = 'You should know side-agent observation (unverified).'
const LAST_LINE = 'Weigh it against your current task'

test('cleaned text keeps no control, invisible or unpaired characters', () => {
  fc.assert(
    fc.property(text, value => {
      const cleaned = cleanText(value)
      assert.ok(cleaned.isWellFormed(), 'unpaired surrogate')
      assert.doesNotMatch(cleaned, FORBIDDEN)
      assert.doesNotMatch(cleaned, /\n{3}/)
    }),
    RUNS,
  )
})

test('cleaned text is cut to the note limit', () => {
  fc.assert(
    fc.property(fc.array(text, { maxLength: 4 }).map(parts => parts.join('').repeat(8)), value => {
      assert.ok(Array.from(cleanText(value)).length <= MAX_NOTE_CHARS + 2)
    }),
    RUNS,
  )
})

test('cleaned text is cut to the expanded limit', () => {
  fc.assert(
    // The leading run of `x` survives cleaning, so the cut always has more than
    // 1,500 characters to work on, however much of the rest is dropped.
    fc.property(fc.array(text, { maxLength: 4 }).map(parts => `${'x'.repeat(2000)}${`${parts.join('')}x`.repeat(9000)}`), value => {
      const cleaned = Array.from(cleanText(value, EXPANDED_NOTE_CHARS))
      assert.ok(cleaned.length <= EXPANDED_NOTE_CHARS + 2)
      assert.ok(cleaned.length > MAX_NOTE_CHARS)
    }),
    { numRuns: 300 },
  )
})

// The stray-joiner rule in its plainest form: a joiner or selector that only
// joiners and selectors separate from the start, from ASCII or from a
// fullwidth or small `<` is dropped, unless U+20E3 follows it.
const JOINER_CLASS = `${cp(0x200c)}${cp(0x200d)}${cp(0xfe0e)}${cp(0xfe0f)}`
const STRAY_RULE = new RegExp(
  `(?<=(?:^|[\\x00-\\x7F${cp(0xff1c)}${cp(0xfe64)}])[${JOINER_CLASS}]*)[${JOINER_CLASS}](?!${cp(0x20e3)})`,
  'gu',
)

// Characters no other cleaning step changes, so only the joiner rule acts.
const joinerText = fc
  .array(fc.constantFrom(
    'a', '1', ' ', '<', cp(0xff1c), cp(0xfe64), 'é', cp(0x1d42e), cp(0x1f600), cp(0x20e3),
    cp(0x200c), cp(0x200d), cp(0xfe0e), cp(0xfe0f),
  ), { maxLength: 60 })
  .map(parts => parts.join(''))

test('joiners and selectors are dropped exactly where the rule says', () => {
  fc.assert(
    fc.property(joinerText, value => {
      assert.equal(cleanText(value), value.replace(STRAY_RULE, ''))
    }),
    RUNS,
  )
})

test('cleaning a long run of joiners takes time in proportion to it', () => {
  const run = `é${cp(0x200d).repeat(200_000)}`
  const started = performance.now()
  const cleaned = cleanText(run, 250_000)
  // The quadratic form of the rule takes tens of seconds on this run.
  assert.ok(performance.now() - started < 2_000)
  assert.equal(cleaned, run)
})

test('a note with a huge number of backtick runs is still fenced', () => {
  const value = { line: 'x', tag: 'Heads up', isTagged: true, explanation: '` '.repeat(300_000) }
  const lines = fencedNote(value, 1_000_000).split('\n')
  assert.equal(lines[0], '```text')
  assert.equal(lines.at(-1), '```')
})

test('a one-line quote has no line break and stays short', () => {
  fc.assert(
    fc.property(text, value => {
      const line = oneLine(value)
      assert.doesNotMatch(line, LINE_BREAK)
      assert.ok(Array.from(line).length <= ONE_LINE_CHARS + 2)
    }),
    RUNS,
  )
})

test('the note cannot close its fence', () => {
  fc.assert(
    fc.property(note, value => {
      const lines = fencedNote(value).split('\n')
      const fence = lines[0].slice(0, -'text'.length)
      assert.match(fence, /^`{3,}$/)
      assert.equal(lines[0], `${fence}text`)
      assert.equal(lines.at(-1), fence)
      assert.ok(longestBacktickRun(lines.slice(1, -1).join('\n')) < fence.length)
    }),
    RUNS,
  )
})

test('the note cannot open or close a protected tag', () => {
  fc.assert(
    fc.property(note, value => {
      assert.doesNotMatch(fencedNote(value).normalize('NFKC').replace(FILLER, ''), PROTECTED)
    }),
    RUNS,
  )
})

// Each letter of a name as itself, in upper case, or as a fullwidth,
// mathematical bold, sans-serif or monospace letter; each `-`, `_` and `:` as
// itself or a small or fullwidth form. All of them read as the name in NFKC.
const LETTER_FORMS = [0, 0xff41, 0x1d41a, 0x1d5ba, 0x1d68a]
const MARK_FORMS = { '-': ['-', cp(0xfe63), cp(0xff0d)], _: ['_', cp(0xfe4d), cp(0xff3f)], ':': [':', cp(0xfe55), cp(0xff1a)] }
// A letter outside ASCII may also be followed by a run of joiners and
// selectors, which cleaning keeps there.
const JOINER_RUN = fc.array(fc.constantFrom(cp(0x200c), cp(0x200d), cp(0xfe0e), cp(0xfe0f)), { maxLength: 20 })
  .map(run => run.join(''))
const spelled = name =>
  fc.tuple(...Array.from(name, char => {
    if (char in MARK_FORMS) return fc.constantFrom(...MARK_FORMS[char])
    const offset = char.charCodeAt(0) - 0x61
    return fc.tuple(fc.constantFrom(...LETTER_FORMS), JOINER_RUN).map(([base, run]) =>
      base === 0 || offset < 0 || offset >= 26 ? char : cp(base + offset) + run)
  })).map(chars => chars.join(''))

const disguisedTag = fc.constantFrom(...PROTECTED_NAMES).chain(name =>
  fc.tuple(
    fc.constantFrom('<', '</', cp(0xff1c), cp(0xfe64), `<${cp(0xff0f)}`, `< ${cp(0x200d)}/`),
    spelled(name.toLowerCase()),
    fc.constantFrom('>', cp(0xff1e), ' x="1">', ''),
  ).map(parts => parts.join('')))

test('a protected tag spelled in compatibility letters is escaped too', () => {
  fc.assert(
    fc.property(text, disguisedTag, text, (before, tag, after) => {
      const fenced = fencedNote({ line: `${before}${tag}${after}`, tag: 'Heads up', isTagged: true, explanation: '' })
      assert.doesNotMatch(fenced.normalize('NFKC').replace(FILLER, ''), PROTECTED)
    }),
    RUNS,
  )
})

test('a selector inside a name in mathematical letters does not hide the tag', () => {
  const fullwidthPadded = Array.from('system', char => cp(0xff41 + char.charCodeAt(0) - 0x61) + cp(0x200c).repeat(16)).join('')
  for (const line of [
    `<${cp(0x1d42e, 0xfe0f)}ser`,
    `</${cp(0x1d42c, 0x200d)}ystem-reminder>`,
    `<${cp(0x1d42e, 0xfe0e, 0xfe0f)}ser>`,
    `<${cp(0x1d42e)}${cp(0xfe0f).repeat(70)}ser>`,
    `<${fullwidthPadded}-reminder>`,
  ]) {
    const fenced = fencedNote({ line, tag: 'Heads up', isTagged: true, explanation: '' })
    assert.doesNotMatch(fenced.normalize('NFKC').replace(FILLER, ''), PROTECTED)
  }
})

test('the framing around the note stays first and last', () => {
  fc.assert(
    fc.property(note, value => {
      const lines = contextText(value).split('\n')
      assert.ok(lines[0].startsWith(FIRST_LINE))
      assert.ok(lines.at(-1).startsWith(LAST_LINE))
      assert.equal(lines.filter(line => line.startsWith(FIRST_LINE)).length, 1)
    }),
    RUNS,
  )
})

test('every transcript line of a note is marked as quoted', () => {
  fc.assert(
    fc.property(note, value => {
      for (const line of transcriptText(value).split('\n')) assert.ok(line.startsWith('│ '))
    }),
    RUNS,
  )
})
