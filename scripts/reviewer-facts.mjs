#!/usr/bin/env node
// Reads, from a Claude Code build, the facts about the You should know
// reviewer that the relay depends on, and compares them with a saved
// baseline. Only names that survive minification are read (store keys, object
// keys, string literals), so a rebuild that renames variables compares equal.
//
//   node scripts/reviewer-facts.mjs <claude binary>...                     print the facts
//   node scripts/reviewer-facts.mjs <claude binary>... --release <version> print a baseline
//   node scripts/reviewer-facts.mjs <claude binary>... --baseline <file>   compare each build
//
// Builds of one release on several platforms give one baseline: their facts
// must agree, except the tags a note's escaping leaves open, which are joined.
//
// Exit codes: 0 facts match the baseline (or were printed), 3 they differ,
// 1 the build could not be read.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { REVIEWER, isEscapedTagName } from '../hooks/note.ts'

/**
 * Store calls further apart than this belong to different modules. In 2.1.325
 * the widest gap inside the reviewer is about 42k and the nearest other
 * module's store call is about 184k away, so this leaves room on both sides.
 * The reviewer's scan record sits about 21k before its first store call.
 */
export const MODULE_GAP = 100_000

/** How far either side of the stored note to look for the reviewer's store calls. */
const SEARCH_SPAN = 1_000_000

const OFFER_KIND = /\bkind:\s*(["'`])offer\1/g
const STORE_CALL = /store\.(get|set|delete)\((["'`])([\w-]+)\2/g
const SCAN_RECORD = /\bscan:\s*\{/g
// A `turn.step` hook whose first statement passes a subagent's step through
// untouched: `async function*($, e, next) { if (e.agentId !== undefined) return yield* next(e)`.
const MAIN_LOOP_STEP = /(["'`])turn\.step\1,\s*async\s*function\*\s*\(([\w$]+),\s*([\w$]+),\s*([\w$]+)\)\s*\{\s*if\s*\(\s*\3\.agentId\s*!==?\s*(?:void 0|undefined)\s*\)\s*return\s+yield\s*\*\s*\4\(\3\)/g
// The band's render hook: `on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {`.
const BAND_HOOK = /(["'`])ui\.render\1,\s*\{\s*component:\s*(["'`])AbovePrompt\2\s*\},\s*async\s*(?:function\s*)?\([^)]*\)\s*(?:=>\s*)?\{/g
const SESSIONS_READ = /\.store\.get\((["'`])sessions\1\)/
// A closing tag as a prompt or a harness block writes it, after text rather
// than machine code: the build's native code holds chance matches.
const CLOSING_TAG = /(?<=[\t\n\x20-\x7E]{8})<\/([a-z][a-z0-9_:-]{1,40})>/g
const OPENING_TAG = /<([a-z][a-z0-9_:-]{1,40})[\s>]/g

/**
 * HTML and SVG elements: closing tags of markup the build renders or quotes,
 * which a note does not need escaped.
 */
const MARKUP = new Set(`a abbr address area article aside audio b bdi bdo blockquote body br button canvas caption center
cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure font footer
form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta
meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search
section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time
title tr track u ul var video wbr svg g defs path rect circle ellipse line polyline polygon text tspan clippath mask
symbol use lineargradient radialgradient stop pattern filter image marker foreignobject`.split(/\s+/))

/** Facts compared by what a build adds; a name a build drops leaves nothing to escape. */
const ADDITIVE = new Set(['unescapedClosingTags'])

/** Index of the brace or bracket that closes the one opening at `open`, skipping strings. */
const closingIndex = (text, open) => {
  const pairs = { '{': '}', '[': ']', '(': ')' }
  const stack = []
  for (let i = open; i < text.length; i++) {
    const char = text[i]
    if (char === '"' || char === "'" || char === '`') {
      for (i++; i < text.length && text[i] !== char; i++) if (text[i] === '\\') i++
      continue
    }
    if (pairs[char]) stack.push(pairs[char])
    else if (char === stack.at(-1)) {
      stack.pop()
      if (stack.length === 0) return i
    }
  }
  return -1
}

/** Index of the brace that opens the object enclosing `at`, skipping nothing it cannot see. */
const openingIndex = (text, at) => {
  let depth = 0
  for (let i = at - 1; i >= 0 && at - i < 10_000; i--) {
    const char = text[i]
    if (char === '}' || char === ']' || char === ')') depth++
    else if (char === '{' || char === '[' || char === '(') {
      if (depth === 0) return char === '{' ? i : -1
      depth--
    }
  }
  return -1
}

/** Each member of an object literal at its own level, as its source text. */
const members = literal => {
  const found = []
  let start = 1
  for (let i = 1; i < literal.length; i++) {
    const char = literal[i]
    if (char === '"' || char === "'" || char === '`') {
      for (i++; i < literal.length && literal[i] !== char; i++) if (literal[i] === '\\') i++
    } else if (char === '{' || char === '[' || char === '(') {
      i = closingIndex(literal, i)
      if (i === -1) break
    } else if (char === ',' || i === literal.length - 1) {
      found.push(literal.slice(start, i).trim())
      start = i + 1
    }
  }
  return found
}

const KEY = /^(["'`]?)([\w$]+)\1\s*:/

/** The keys an object literal sets at its own level, sorted; spreads count as `...`. */
export const objectKeys = literal => {
  const keys = members(literal).flatMap(member => {
    if (member.startsWith('...')) return ['...']
    const key = member.match(KEY) ?? member.match(/^()([\w$]+)$/)
    return key ? [key[2]] : []
  })
  return [...new Set(keys)].sort()
}

/** The source of the value an object literal gives `key`, or undefined. */
const memberValue = (literal, key) => {
  for (const member of members(literal)) {
    const found = member.match(KEY)
    if (found?.[2] === key) return member.slice(found[0].length).trim()
  }
  return undefined
}

/** The store calls near `at` that sit in one run, no two further apart than MODULE_GAP. */
const storeCallsAround = (text, at) => {
  const from = Math.max(0, at - SEARCH_SPAN)
  const calls = [...text.slice(from, at + SEARCH_SPAN).matchAll(STORE_CALL)].map(m => ({ at: from + m.index, key: m[3] }))
  if (calls.length === 0) return []
  let nearest = calls.reduce((best, call, i) => (Math.abs(call.at - at) < Math.abs(calls[best].at - at) ? i : best), 0)
  let first = nearest
  let last = nearest
  while (first > 0 && calls[first].at - calls[first - 1].at <= MODULE_GAP) first--
  while (last < calls.length - 1 && calls[last + 1].at - calls[last].at <= MODULE_GAP) last++
  if (Math.abs(calls[nearest].at - at) > MODULE_GAP) return []
  return calls.slice(first, last + 1)
}

/** Where each `view: { kind: 'offer', ... }` object opens, whatever order its keys are in. */
const offerViews = text =>
  [...text.matchAll(OFFER_KIND)]
    .map(m => openingIndex(text, m.index))
    .filter(open => open !== -1 && /view:\s*$/.test(text.slice(Math.max(0, open - 8), open)))

/** The string literals of an array literal's source, in order. */
const strings = source => [...source.matchAll(/(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g)].map(m => m[2])

/** The array literal a record gives `name`, as source, or '' when it has none. */
const arrayOf = (literal, name) => {
  const at = literal.search(new RegExp(`\\b${name}:\\s*\\[`))
  if (at === -1) return ''
  const open = literal.indexOf('[', at)
  return literal.slice(open, closingIndex(literal, open) + 1)
}

/** `plugin/key` for each `{ plugin, key }` of a state list, sorted. */
const stateRefs = source =>
  [...source.matchAll(/\{[^{}]*\}/g)]
    .map(m => `${strings(memberValue(m[0], 'plugin') ?? '')[0] ?? '?'}/${strings(memberValue(m[0], 'key') ?? '')[0] ?? '?'}`)
    .sort()

/**
 * The scan record the build keeps for the reviewer's hooks module: the last
 * one before the module's first store call, within MODULE_GAP of it.
 */
const scanRecordBefore = (text, at) => {
  const from = Math.max(0, at - MODULE_GAP)
  const last = [...text.slice(from, at).matchAll(SCAN_RECORD)].at(-1)
  if (last === undefined) return undefined
  const open = from + last.index + last[0].length - 1
  const end = closingIndex(text, open)
  return end === -1 ? undefined : { at: open, literal: text.slice(open, end + 1) }
}

/** What the scan record says the module hooks, calls and reads or writes of `$.state`. */
const scanFacts = literal => {
  const state = memberValue(literal, 'state') ?? ''
  return {
    scanHooks: strings(arrayOf(literal, 'hooks')).sort(),
    scanCalls: strings(arrayOf(literal, 'calls')).sort(),
    scanStateReads: stateRefs(arrayOf(state, 'reads')),
    scanStateWrites: stateRefs(arrayOf(state, 'writes')),
  }
}

/**
 * The `turn.step` hook the offer is made in, when it passes subagent steps
 * through first: where its body opens and closes, and its event's name.
 */
const mainLoopStepAround = (text, from, offerAt) => {
  for (const m of text.slice(from, offerAt).matchAll(MAIN_LOOP_STEP)) {
    const open = text.indexOf('{', from + m.index + m[0].indexOf(')'))
    const end = closingIndex(text, open)
    if (open < offerAt && offerAt < end) return { event: m[3] }
  }
  return undefined
}

/** How many band render hooks starting between `from` and `to` read the stored `sessions` value. */
const bandReads = (text, from, to) =>
  [...text.slice(from, to).matchAll(BAND_HOOK)].filter(m => {
    const open = from + m.index + m[0].length - 1
    const end = closingIndex(text, open)
    return end !== -1 && SESSIONS_READ.test(text.slice(open, end + 1))
  }).length

/**
 * Names of the tags the build both opens and closes that a note keeps as
 * written: not escaped by the relay's rule, and not HTML or SVG. A release
 * that adds one may wrap text in a block a note could open or close.
 */
export const unescapedClosingTags = text => {
  const closed = new Set()
  for (const m of text.matchAll(CLOSING_TAG)) {
    if (!MARKUP.has(m[1]) && !isEscapedTagName(m[1])) closed.add(m[1])
  }
  const opened = new Set()
  for (const m of text.matchAll(OPENING_TAG)) if (closed.has(m[1])) opened.add(m[1])
  return [...opened].sort()
}

/** The facts the relay depends on, read from the text of a Claude Code build. */
export const reviewerFacts = text => {
  const offers = offerViews(text)
  const facts = {
    reviewerName: false,
    offerCount: offers.length,
    entryKeys: null,
    viewKeys: null,
    offeredTurnIsStepTurn: false,
    offerInMainLoopStep: false,
    storeKeys: [],
    seenWrittenBeforeOffer: false,
    seenWritesOfLines: 0,
    sessionsWritesWithId: 0,
    sessionsWritesClearingView: 0,
    bandReadsSessions: false,
    scanHooks: null,
    scanCalls: null,
    scanStateReads: null,
    scanStateWrites: null,
    unescapedClosingTags: unescapedClosingTags(text),
  }
  if (offers.length !== 1) return facts

  const viewAt = offers[0]
  const viewEnd = closingIndex(text, viewAt)
  const entryAt = openingIndex(text, viewAt)
  const entryEnd = entryAt === -1 ? -1 : closingIndex(text, entryAt)
  const entry = entryEnd === -1 ? '' : text.slice(entryAt, entryEnd + 1)
  if (viewEnd !== -1) facts.viewKeys = objectKeys(text.slice(viewAt, viewEnd + 1))
  if (entry !== '') facts.entryKeys = objectKeys(entry)

  const calls = storeCallsAround(text, viewAt)
  facts.storeKeys = [...new Set(calls.map(call => call.key))].sort()
  if (calls.length === 0) return facts
  const blockEnd = closingIndex(text, text.indexOf('(', calls.at(-1).at)) + 1
  const block = text.slice(calls[0].at, blockEnd)

  const scan = scanRecordBefore(text, calls[0].at)
  const moduleStart = scan?.at ?? calls[0].at
  const module = text.slice(moduleStart, blockEnd)
  facts.reviewerName = module.includes(`"${REVIEWER}"`) || module.includes(`'${REVIEWER}'`) || module.includes(`\`${REVIEWER}\``)
  if (scan !== undefined) Object.assign(facts, scanFacts(scan.literal))

  const step = mainLoopStepAround(text, moduleStart, viewAt)
  facts.offerInMainLoopStep = step !== undefined
  facts.offeredTurnIsStepTurn = step !== undefined && memberValue(entry, 'offeredTurn') === `${step.event}.turnId`
  facts.bandReadsSessions = bandReads(text, moduleStart, blockEnd) === 1

  const seenWrites = calls.filter(call => call.key === 'seen' && text.startsWith('store.set', call.at))
  const lastSeenBefore = seenWrites.filter(call => call.at < entryAt).at(-1)
  facts.seenWrittenBeforeOffer = lastSeenBefore !== undefined && entryAt - lastSeenBefore.at < 400
  // Counted, not just found, so a release that drops one of several writes shows.
  const count = pattern => [...block.matchAll(pattern)].length
  facts.seenWritesOfLines = count(/store\.set\((["'`])seen\1,\s*\[\.\.\.[\w$.]+,\s*[\w$]+\.line\]/g)
  facts.sessionsWritesWithId = count(/store\.set\((["'`])sessions\1,[^;]{0,200}?\bid:/g)
  facts.sessionsWritesClearingView = count(/store\.set\((["'`])sessions\1,[^;]{0,200}?view:(?:void 0|undefined)\b/g)
  return facts
}

/** One line per fact that differs between the baseline and the build. */
export const differences = (baseline, facts) =>
  Object.keys({ ...baseline, ...facts }).flatMap(key => {
    const [before, after] = [baseline[key], facts[key]]
    if (ADDITIVE.has(key) && Array.isArray(before) && Array.isArray(after)) {
      const added = after.filter(name => !before.includes(name))
      return added.length === 0 ? [] : [`${key}: new in this build: ${added.join(', ')}`]
    }
    return JSON.stringify(before) === JSON.stringify(after)
      ? []
      : [`${key}: ${JSON.stringify(before)} in the baseline, ${JSON.stringify(after)} in this build`]
  })

/** The facts of the Claude Code build at `binary`. */
export const readFacts = binary => reviewerFacts(readFileSync(binary, 'latin1'))

/**
 * One baseline for builds of the same release on several platforms. Their
 * facts must agree, except the additive ones, which differ by platform (each
 * build bundles its own native code and prompts) and are joined.
 */
export const mergeFacts = all =>
  all.reduce((merged, facts) => {
    const keys = Object.keys({ ...merged, ...facts })
    return Object.fromEntries(keys.map(key => {
      const [left, right] = [merged[key], facts[key]]
      if (ADDITIVE.has(key) && Array.isArray(left) && Array.isArray(right)) return [key, [...new Set([...left, ...right])].sort()]
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        throw new Error(`the builds disagree on ${key}: ${JSON.stringify(left)} and ${JSON.stringify(right)}`)
      }
      return [key, left]
    }))
  })

const USAGE = 'usage: reviewer-facts.mjs <claude binary>... [--baseline <file> | --release <version>]'

const main = args => {
  const flagAt = args.findIndex(arg => arg.startsWith('--'))
  const binaries = flagAt === -1 ? args : args.slice(0, flagAt)
  const [flag, value, ...rest] = flagAt === -1 ? [] : args.slice(flagAt)
  if (binaries.length === 0 || rest.length > 0 || (flag !== undefined && (!['--baseline', '--release'].includes(flag) || !value))) {
    console.error(USAGE)
    return 1
  }
  const each = binaries.map(readFacts)
  if (flag === '--baseline') {
    const baseline = JSON.parse(readFileSync(value, 'utf8')).facts
    const changed = [...new Set(each.flatMap(facts => differences(baseline, facts)))]
    for (const line of changed) console.log(line)
    return changed.length === 0 ? 0 : 3
  }
  const facts = mergeFacts(each)
  console.log(JSON.stringify(flag === '--release' ? { release: value, facts } : facts, null, 2))
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`reviewer-facts: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
