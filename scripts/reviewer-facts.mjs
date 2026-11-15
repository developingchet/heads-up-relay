#!/usr/bin/env node
// Reads, from a Claude Code build, the facts about the You should know
// reviewer's storage that the relay depends on, and compares them with a saved
// baseline. Only names that survive minification are read (store keys, object
// keys, string literals), so a rebuild that renames variables compares equal.
//
//   node scripts/reviewer-facts.mjs <claude binary>                     print the facts
//   node scripts/reviewer-facts.mjs <claude binary> --release <version> print a baseline
//   node scripts/reviewer-facts.mjs <claude binary> --baseline <file>   compare
//
// Exit codes: 0 facts match the baseline (or were printed), 3 they differ,
// 1 the build could not be read.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Store calls further apart than this belong to different modules. In 2.1.325
 * the widest gap inside the reviewer is about 42k and the nearest other
 * module's store call is about 184k away, so this leaves room on both sides.
 */
export const MODULE_GAP = 100_000

/** How far either side of the stored note to look for the reviewer's store calls. */
const SEARCH_SPAN = 1_000_000

const OFFER_KIND = /\bkind:\s*(["'`])offer\1/g
const STORE_CALL = /store\.(get|set|delete)\((["'`])([\w-]+)\2/g

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

/** The keys an object literal sets at its own level, sorted; spreads count as `...`. */
export const objectKeys = literal => {
  const keys = []
  let start = 1
  for (let i = 1; i < literal.length; i++) {
    const char = literal[i]
    if (char === '"' || char === "'" || char === '`') {
      for (i++; i < literal.length && literal[i] !== char; i++) if (literal[i] === '\\') i++
    } else if (char === '{' || char === '[' || char === '(') {
      i = closingIndex(literal, i)
      if (i === -1) break
    } else if (char === ',' || i === literal.length - 1) {
      const member = literal.slice(start, i).trim()
      start = i + 1
      if (member.startsWith('...')) keys.push('...')
      else {
        const key = member.match(/^(["'`]?)([\w$]+)\1\s*:/) ?? member.match(/^()([\w$]+)$/)
        if (key) keys.push(key[2])
      }
    }
  }
  return [...new Set(keys)].sort()
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

/** The facts the relay depends on, read from the text of a Claude Code build. */
export const reviewerFacts = text => {
  const offers = offerViews(text)
  const facts = {
    reviewerName: text.includes('cc-plugin-you-should-know'),
    offerCount: offers.length,
    entryKeys: null,
    viewKeys: null,
    storeKeys: [],
    seenWrittenBeforeOffer: false,
    seenWritesOfLines: 0,
    sessionsWritesWithId: 0,
    sessionsWritesClearingView: 0,
  }
  if (offers.length !== 1) return facts

  const viewAt = offers[0]
  const viewEnd = closingIndex(text, viewAt)
  const entryAt = openingIndex(text, viewAt)
  const entryEnd = entryAt === -1 ? -1 : closingIndex(text, entryAt)
  if (viewEnd !== -1) facts.viewKeys = objectKeys(text.slice(viewAt, viewEnd + 1))
  if (entryEnd !== -1) facts.entryKeys = objectKeys(text.slice(entryAt, entryEnd + 1))

  const calls = storeCallsAround(text, offers[0])
  facts.storeKeys = [...new Set(calls.map(call => call.key))].sort()
  const block = calls.length === 0 ? '' : text.slice(calls[0].at, closingIndex(text, text.indexOf('(', calls.at(-1).at)) + 1)

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
  Object.keys({ ...baseline, ...facts })
    .filter(key => JSON.stringify(baseline[key]) !== JSON.stringify(facts[key]))
    .map(key => `${key}: ${JSON.stringify(baseline[key])} in the baseline, ${JSON.stringify(facts[key])} in this build`)

/** The facts of the Claude Code build at `binary`. */
export const readFacts = binary => reviewerFacts(readFileSync(binary, 'latin1'))

const main = args => {
  const [binary, flag, value] = args
  if (!binary || (flag !== undefined && (!['--baseline', '--release'].includes(flag) || !value))) {
    console.error('usage: reviewer-facts.mjs <claude binary> [--baseline <file> | --release <version>]')
    return 1
  }
  const facts = readFacts(binary)
  if (flag === undefined) {
    console.log(JSON.stringify(facts, null, 2))
    return 0
  }
  if (flag === '--release') {
    console.log(JSON.stringify({ release: value, facts }, null, 2))
    return 0
  }
  const baseline = JSON.parse(readFileSync(value, 'utf8')).facts
  const changed = differences(baseline, facts)
  for (const line of changed) console.log(line)
  return changed.length === 0 ? 0 : 3
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`reviewer-facts: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
