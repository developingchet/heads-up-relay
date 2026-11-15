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

// A tag opener the relay escapes: `<` in any width, up to three spaces and a
// slash, then an envelope, role, tool-call or namespaced name.
const OPENER = `[<${cp(0xff1c)}${cp(0xfe64)}]`
const PROTECTED = new RegExp(
  `${OPENER}(?=\\s{0,3}\\/?\\s{0,3}(?:system|user|human|assistant|function_calls|invoke|parameters?|task|tool[\\w-]*|local|[a-z]+:[\\w-]+)(?:[_-][\\w-]*)?(?!\\w))`,
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
      assert.doesNotMatch(fencedNote(value), PROTECTED)
    }),
    RUNS,
  )
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
