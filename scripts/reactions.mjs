#!/usr/bin/env node
// Shows how the main agent went on after each note heads-up-relay added to a
// session: the note, then the agent's text and tool calls up to the end of
// that turn (the next prompt the person typed). Each note is headed by its
// row's uuid, which the relay's debug log names when it adds the note.
//
// Run with Node 24 or later, which loads hooks/note.ts directly:
//   node scripts/reactions.mjs <session.jsonl | session id> [--steps N]

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cleanText } from '../hooks/note.ts'

const RELAY = 'heads-up-relay'
const DEFAULT_STEPS = 20
const TEXT_CHARS = 400
const SESSION_ID = /^[\w-]+$/

const usage = () => {
  process.stderr.write('usage: node scripts/reactions.mjs <session.jsonl | session id> [--steps N]\n')
  process.exit(2)
}

/** The transcript file for a path or a session id under ~/.claude/projects. */
function transcriptPath(target) {
  if (existsSync(target)) return target
  if (!SESSION_ID.test(target)) throw new Error(`not a transcript path or a session id: ${target}`)
  const projects = join(homedir(), '.claude', 'projects')
  for (const folder of readdirSync(projects)) {
    const candidate = join(projects, folder, `${target}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`no transcript found for ${target}`)
}

function readEntries(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

const blocksOf = entry => {
  const content = entry?.message?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

const isNote = entry =>
  entry.type === 'user' && entry.isMeta === true && entry.origin?.kind === 'plugin' && entry.origin?.name === RELAY

/** A prompt the person typed: a user row that is neither hidden nor a tool result. */
const isTypedPrompt = entry =>
  entry.type === 'user' &&
  entry.isMeta !== true &&
  !entry.isSidechain &&
  blocksOf(entry).some(block => block.type === 'text') &&
  !blocksOf(entry).some(block => block.type === 'tool_result')

/** The note's own text, from inside the fence the relay puts it in. */
function noteText(entry) {
  const text = printable(blocksOf(entry).find(block => block.type === 'text')?.text ?? '')
  const lines = text.split('\n')
  const open = lines.findIndex(line => /^`{3,}text$/.test(line))
  if (open === -1) return text
  const fence = lines[open].slice(0, -'text'.length)
  const close = lines.indexOf(fence, open + 1)
  return lines.slice(open + 1, close === -1 ? undefined : close).join('\n')
}

/** Transcript text cleaned as the relay cleans a note, so it cannot drive or hide anything in the terminal. */
const printable = text => cleanText(String(text), Infinity)

const short = (text, max = TEXT_CHARS) => {
  const flat = printable(text).replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)} …`
}

/** What a tool call was asked to do, in a few words. */
function callSummary(block) {
  const input = block.input ?? {}
  const detail = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.description ?? ''
  return `${block.name}${detail ? `: ${short(detail, 140)}` : ''}`
}

function reactionsAfter(entries, start, maxSteps) {
  const lines = []
  for (const entry of entries.slice(start + 1)) {
    if (isTypedPrompt(entry)) {
      lines.push('  [turn ended: next typed prompt]')
      return lines
    }
    if (entry.type !== 'assistant' || entry.isSidechain) continue
    for (const block of blocksOf(entry)) {
      if (lines.length >= maxSteps) {
        lines.push(`  [stopped after ${maxSteps} steps]`)
        return lines
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) lines.push(`  says:  ${short(block.text)}`)
      if (block.type === 'tool_use') lines.push(`  calls: ${callSummary(block)}`)
    }
  }
  lines.push('  [end of transcript]')
  return lines
}

function main(argv) {
  const [target, ...rest] = argv
  if (!target) usage()
  const stepsAt = rest.indexOf('--steps')
  const maxSteps = stepsAt === -1 ? DEFAULT_STEPS : Number(rest[stepsAt + 1])
  if (!Number.isInteger(maxSteps) || maxSteps < 1) usage()

  const path = transcriptPath(target)
  const entries = readEntries(path)
  const notes = entries.flatMap((entry, index) => (isNote(entry) ? [index] : []))

  process.stdout.write(`${path}\n${notes.length} note(s) from ${RELAY}\n`)
  for (const index of notes) {
    const entry = entries[index]
    process.stdout.write(`\n== ${entry.timestamp ?? 'unstamped'} ${printable(entry.uuid ?? 'no uuid')}\n`)
    for (const line of noteText(entry).split('\n')) process.stdout.write(`  > ${line}\n`)
    process.stdout.write('  -- then:\n')
    for (const line of reactionsAfter(entries, index, maxSteps)) process.stdout.write(`${line}\n`)
  }
}

try {
  main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`reactions: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
