import type { EngineInterface as Engine, Next, Origin, Register, Timer } from 'claude-code'
import type { HeldNote, ReviewerNote } from '../types'
import {
  REVIEWER,
  contextText,
  hasOffer,
  noteKey,
  oneLine,
  shownNote,
  transcriptText,
  withoutView,
} from './note'

/** The keys the reviewer is known to write; any other means its layout moved. */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'sessions',
  'seen',
  'known',
  'typedPastInARow',
  'looksToSkip',
])

/** How long a note recorded in `seen` may go without a readable offer. */
const OFFER_WAIT_MS = 10_000

/**
 * How long the reviewer's write waits for an append before going on with the
 * note left on the band. An append is stored at once, so this only bounds
 * one that hangs. A `sessions` write queued behind others spends its own
 * 10-second hook budget while they wait, so this stays well under a third
 * of it.
 */
const APPEND_WAIT_MS = 3_000

/**
 * The hook budget a write needs left to try an append: the append's own wait
 * costs nothing, the relay's code around it little. With less, the write goes
 * on unchanged and the note stays on the band.
 */
const APPEND_BUDGET_MS = 1_000

/** Where notes held while a reply streams are kept: the host holds it through a reload of the module. */
const HELD = { plugin: 'heads-up-relay', key: 'held' } as const

/** Tries at writing the held notes when another load of the module wrote them in between. */
const HELD_WRITE_TRIES = 3

/** What a reviewer call the relay no longer takes part in resolves to. */
const SETTLED = { value: undefined } as const

type Mode = 'append' | 'log'

/** One main-loop model request, from its start until its stream ends or is aborted. */
type Reply = { readonly turnId: string; readonly index: number }

/** An append, stored under a row id or refused with a reason. */
type Appended = { readonly uuid: string } | { readonly refusal: string }

/** What one load of the module remembers between the reviewer's writes. */
type Relay = {
  readonly mode: Mode
  /**
   * Each note handled, by key: whether it is now in the main conversation.
   * Every write that carries the note waits on the same answer.
   */
  readonly handled: Map<string, Promise<boolean>>
  readonly warned: Set<string>
  isStatusShown: boolean
  lastSeen: string | undefined
  awaitingOffer: { readonly line: string; readonly timer: Timer } | undefined
  /**
   * The reviewer's `sessions` writes, one after another: a write held for an
   * append is stored before any write the reviewer made after it, and before
   * the reviewer reads the value again.
   */
  sessionsWrites: Promise<void>
  /**
   * When this load of the module, or the conversation it serves, started. A
   * note shown before it was on the band before the relay could take it, so
   * it is left there.
   */
  loadedAt: number | undefined
  /** This conversation's session id, read once. */
  sessionId: Promise<string> | undefined
  /** The main-loop model request streaming now. */
  reply: Reply | undefined
  /** Changes to the held notes, one after another. */
  heldChanges: Promise<unknown>
  /** Whether HELD may hold notes: true at load, since an earlier load may have left some. */
  mayHold: boolean
}

type WarnOptions = {
  /** False for a warning about the layout that does not stop the note. */
  readonly raisesStatus?: boolean
  /** True for a warning about one note, written for every note it applies to. */
  readonly isPerNote?: boolean
}

/** The built-in reviewer, not a plugin of another tier that took its name. */
const isReviewer = ({ plugin, tier }: Origin): boolean =>
  tier === 'builtin' && (plugin === REVIEWER || plugin.startsWith(`${REVIEWER}@`))

const lastLine = (value: readonly unknown[]): string | undefined => {
  const last: unknown = value[value.length - 1]
  return typeof last === 'string' ? last.trim() : undefined
}

const reasonOf = (error: unknown): string =>
  oneLine(error instanceof Error ? error.message : String(error))

/** Reviewer text quoted in a warning: one clean, short line. */
const quoted = (text: string): string => `"${oneLine(text)}"`

/**
 * Whether the dispatch went on without this hook: the person interrupted, or
 * its budget ran out and the engine went on on its behalf. Calling `next`
 * then could store an older value over a newer one.
 */
const isAbandoned = (next: Pick<Next, 'signal' | 'budget'>): boolean =>
  next.signal.aborted || next.budget.remainingMs <= 0

/** Writes to the debug log, never throwing: it is the last place to report to. */
function debug($: Engine, text: string): void {
  try {
    $.ui.log(text, { to: 'debug' })
  } catch {
    // Nothing is left to report a failing debug log to.
  }
}

/**
 * Says that something is wrong, once per kind unless it concerns one note,
 * and for a note that did not get through keeps the status line up until a
 * later note does.
 */
function warn($: Engine, relay: Relay, id: string, text: string, { raisesStatus = true, isPerNote = false }: WarnOptions = {}): void {
  debug($, text)
  try {
    if (raisesStatus && !relay.isStatusShown) {
      relay.isStatusShown = true
      $.ui.status('notes not forwarded, see transcript')
    }
    if (!isPerNote) {
      if (relay.warned.has(id)) return
      relay.warned.add(id)
    }
    $.ui.log(`⚠ ${text}`)
  } catch (error) {
    debug($, `showing a warning failed: ${reasonOf(error)}`)
  }
}

/** Clears the status line once a note has been delivered as intended. */
function delivered($: Engine, relay: Relay): void {
  if (!relay.isStatusShown) return
  relay.isStatusShown = false
  $.ui.status(undefined)
}

/** The time, or undefined where no clock answers. */
const timeNow = ($: Engine): Promise<number | undefined> =>
  $.clock.now().catch((error: unknown) => {
    debug($, `no clock: ${reasonOf(error)}`)
    return undefined
  })

/** This conversation's session id, read once until it ends. */
function sessionIdOf($: Engine, relay: Relay): Promise<string> {
  const known = relay.sessionId ?? $.session.id()
  relay.sessionId = known
  known.catch(() => {
    if (relay.sessionId === known) relay.sessionId = undefined
  })
  return known
}

/**
 * Puts one transcript line where the person sees what the main agent was
 * given, and clears the status line.
 */
function receipt($: Engine, relay: Relay, note: ReviewerNote, uuid: string, isLate = false): void {
  try {
    debug($, `forwarded a ${oneLine(note.tag)} note about turn ${oneLine(note.reviewedTurn ?? '')} as row ${uuid}`)
    $.ui.log(`relayed Claude a note${isLate ? ' after all' : ''}: ${oneLine(note.line)}`)
    delivered($, relay)
  } catch (error) {
    debug($, `reporting a forwarded note failed: ${reasonOf(error)}`)
  }
}

/**
 * Starts the append; it resolves to the stored row's id or the refusal. The
 * call is made before the first await, so appends started one after another
 * are stored in that order, and a call that throws is a refusal too.
 */
async function appendRow($: Engine, note: ReviewerNote): Promise<Appended> {
  try {
    const stored = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: contextText(note) }] } })
    return stored.deny === undefined ? { uuid: stored.uuid } : { refusal: oneLine(String(stored.deny)) }
  } catch (error) {
    return { refusal: reasonOf(error) }
  }
}

/** Resolves after APPEND_WAIT_MS, or never where no clock answers. */
function deadline($: Engine): { readonly elapsed: Promise<'timed out'>; readonly cancel: () => void } {
  let timer: Timer | undefined
  const elapsed = new Promise<'timed out'>(resolve => {
    try {
      timer = $.clock.after(APPEND_WAIT_MS, () => resolve('timed out'))
    } catch (error) {
      debug($, `no clock for the append deadline: ${reasonOf(error)}`)
    }
  })
  return { elapsed, cancel: () => timer?.cancel() }
}

/**
 * The append's outcome by the deadline. One still pending then counts as
 * refused for this write; `onLate` runs if it is stored after all.
 */
async function settle(row: Promise<Appended>, elapsed: Promise<'timed out'>, onLate: (uuid: string) => void): Promise<Appended> {
  const outcome = await Promise.race([row, elapsed])
  if (outcome !== 'timed out') return outcome

  void row.then(late => {
    if ('uuid' in late) onLate(late.uuid)
  })
  return { refusal: `no answer within ${APPEND_WAIT_MS / 1000} s` }
}

/**
 * Stores the note in the main conversation as a user-role row the person does
 * not see as typed. It starts no turn: a running turn reads it from its next
 * request, an idle session from the next prompt.
 */
async function append($: Engine, note: ReviewerNote, onLate: (uuid: string) => void): Promise<Appended> {
  const limit = deadline($)
  try {
    return await settle(appendRow($, note), limit.elapsed, onLate)
  } finally {
    limit.cancel()
  }
}

/** Runs changes to the held notes one after another, in the order asked. */
function queueHeld<T>(relay: Relay, change: () => Promise<T>): Promise<T> {
  const done = relay.heldChanges.then(change)
  relay.heldChanges = done.catch(() => undefined)
  return done
}

/** Rewrites the held notes and returns what they were. */
async function rewriteHeld(
  $: Engine,
  change: (held: readonly HeldNote[]) => readonly HeldNote[],
): Promise<readonly HeldNote[]> {
  for (let attempt = 1; ; attempt++) {
    const { value = [], version } = await $.state.get(HELD)
    const { isSet } = await $.state.set(HELD, change(value), { ifVersion: version })
    if (isSet) return value
    if (attempt === HELD_WRITE_TRIES) throw new Error('the held notes kept changing underneath')
  }
}

/**
 * Adds a note to those held until the reply ends. `mayHold` is set before the
 * write is queued, so a reply that ends while it is under way still takes the
 * note, from behind it in the queue.
 */
function hold($: Engine, relay: Relay, note: HeldNote): Promise<void> {
  relay.mayHold = true
  return queueHeld(relay, async () => {
    await rewriteHeld($, held => [...held, note])
  })
}

/**
 * Takes every held note, leaving none. `mayHold` is cleared before the take,
 * so a note held while it is under way sets it again.
 */
const takeHeld = ($: Engine, relay: Relay): Promise<readonly HeldNote[]> =>
  queueHeld(relay, async () => {
    if (!relay.mayHold) return []
    relay.mayHold = false
    try {
      return await rewriteHeld($, () => [])
    } catch (error) {
      relay.mayHold = true
      throw error
    }
  })

async function deliver($: Engine, relay: Relay, key: string, sessionId: string, note: ReviewerNote): Promise<boolean> {
  if (note.reviewedTurn === undefined) {
    warn($, relay, 'turn-missing', `the reviewer showed a note without the turn it reviewed, so it was not sent: ${quoted(note.line)}`)
    return false
  }
  if (note.shownAt === undefined) {
    warn($, relay, 'time-missing', `the reviewer showed a note without the time it showed it, so it was not sent: ${quoted(note.line)}`)
    return false
  }
  // A note shown before this load of the module, or before the conversation
  // started, was on the band before the relay could take it; it is left there.
  if (relay.loadedAt !== undefined && note.shownAt < relay.loadedAt) {
    debug($, `skipped a note shown before the relay loaded: ${quoted(note.line)}`)
    return false
  }

  // A missing tag may mean the reviewer's layout moved; the note still goes
  // on, under the default tag, so the status line is left alone.
  if (!note.isTagged) {
    warn($, relay, 'tag-missing', `the reviewer showed a note without a tag: ${quoted(note.line)}`, { raisesStatus: false })
  }

  if (relay.mode === 'log') {
    $.ui.log(transcriptText(note))
    delivered($, relay)
    return false
  }

  // A row appended while a reply streams is stored ahead of that reply, which
  // never read it, so the next request would show the note as if it had come
  // before the answer. It is held until the reply ends and taken off the band
  // now, so the person is not offered it to send by hand meanwhile.
  if (relay.reply !== undefined) {
    await hold($, relay, { ...note, sessionId })
    debug($, `holding a ${oneLine(note.tag)} note until Claude's reply ends`)
    return true
  }

  // A late append is in the conversation after all: the reviewer's next
  // write of the note takes it off the band.
  const appended = await append($, note, uuid => {
    relay.handled.set(key, Promise.resolve(true))
    receipt($, relay, note, uuid, true)
  })
  if ('refusal' in appended) {
    warn($, relay, 'append-refused', `a note could not be added to the conversation (${appended.refusal}); the reviewer still shows it.`, { isPerNote: true })
    return false
  }
  receipt($, relay, note, appended.uuid)
  return true
}

/**
 * Writes a held note in full to the transcript: it is off the band already,
 * so this is where the person still sees it.
 */
function showInstead($: Engine, relay: Relay, note: ReviewerNote, reason: string): void {
  warn($, relay, 'held-not-sent', `a note held until Claude's reply ended was not added to the conversation (${reason}); it is shown here instead.`, { isPerNote: true })
  try {
    $.ui.log(transcriptText(note))
  } catch (error) {
    debug($, `showing a held note failed: ${reasonOf(error)}`)
  }
}

/**
 * Appends the notes held while Claude's reply streamed. They are started in
 * the order they came, so they are stored in that order, and awaited together
 * under one deadline.
 */
async function flush($: Engine, relay: Relay): Promise<void> {
  const held = await takeHeld($, relay)
  if (held.length === 0) return

  // A note held in another conversation, before a reload that kept it, is not
  // this one's to read.
  const sessionId = await sessionIdOf($, relay).catch(() => undefined)
  const notes = held.filter(note => note.sessionId === sessionId)
  for (const note of held) {
    if (note.sessionId !== sessionId) showInstead($, relay, note, 'it was shown in another conversation')
  }
  if (notes.length === 0) return

  const limit = deadline($)
  const pending = notes.map(note => ({ note, row: appendRow($, note) }))
  const outcomes = await Promise.all(pending.map(async ({ note, row }) => ({
    note,
    appended: await settle(row, limit.elapsed, uuid => receipt($, relay, note, uuid, true)),
  })))
  limit.cancel()

  for (const { note, appended } of outcomes) {
    if ('uuid' in appended) receipt($, relay, note, appended.uuid)
    else showInstead($, relay, note, appended.refusal)
  }
}

/** Shows every held note in the transcript instead of appending it. */
async function showHeld($: Engine, relay: Relay, reason: string): Promise<void> {
  const notes = await takeHeld($, relay).catch((error: unknown) => {
    debug($, `reading the held notes failed: ${reasonOf(error)}`)
    return []
  })
  for (const note of notes) showInstead($, relay, note, reason)
}

/**
 * Whether the note is in the main conversation, delivering it the first time.
 * A write whose dispatch was already abandoned is not delivered, so the note
 * stays on the band, and a later write may still deliver it; so may one
 * after a delivery that failed outright.
 */
function forward(
  $: Engine,
  relay: Relay,
  sessionId: string,
  note: ReviewerNote,
  signal: AbortSignal,
): Promise<boolean> {
  const key = noteKey(sessionId, note)
  const known = relay.handled.get(key)
  if (known !== undefined) return known
  if (signal.aborted) return Promise.resolve(false)

  const answer = deliver($, relay, key, sessionId, note).catch((error: unknown) => {
    relay.handled.delete(key)
    warn($, relay, 'deliver-failed', `forwarding a note failed: ${reasonOf(error)}`, { isPerNote: true })
    return false
  })
  relay.handled.set(key, answer)
  return answer
}

function onSeen($: Engine, relay: Relay, value: unknown): void {
  if (!Array.isArray(value)) {
    warn($, relay, 'seen-shape', 'the reviewer stored `seen` in a form this relay cannot read.')
    return
  }
  const line = lastLine(value)
  if (line === undefined || line === relay.lastSeen) return
  relay.lastSeen = line

  relay.awaitingOffer?.timer.cancel()
  relay.awaitingOffer = {
    line,
    timer: $.clock.after(OFFER_WAIT_MS, () => {
      relay.awaitingOffer = undefined
      warn($, relay, 'offer-missing', `the reviewer showed a note this relay could not read: ${quoted(line)}`)
    }),
  }
}

/**
 * Delivers the note `sessions` shows for this session, and returns the value
 * the reviewer should store: with that note taken down once it is in the main
 * conversation, so the person is not offered it to send by hand. The write
 * waits for the append, so the band never draws a note that was sent.
 */
async function onSessions($: Engine, relay: Relay, value: unknown, signal: AbortSignal): Promise<unknown> {
  if (!hasOffer(value)) return value
  const sessionId = await sessionIdOf($, relay)
  const note = shownNote(value, sessionId)
  if (note === undefined || !Array.isArray(value)) return value

  if (relay.awaitingOffer?.line.toLowerCase() === note.line.toLowerCase()) {
    relay.awaitingOffer.timer.cancel()
    relay.awaitingOffer = undefined
  }
  const isForwarded = await forward($, relay, sessionId, note, signal)
  return isForwarded ? withoutView(value, sessionId) : value
}

/** Reads one reviewer write and returns the value to store in its place. */
async function observe($: Engine, relay: Relay, key: string, value: unknown, signal: AbortSignal): Promise<unknown> {
  if (key === 'sessions') return onSessions($, relay, value, signal)

  if (key === 'seen') onSeen($, relay, value)
  else if (!KNOWN_KEYS.has(key)) {
    warn($, relay, 'unknown-key', `the reviewer wrote a store key this relay does not know (${quoted(key)}); its layout may have changed.`)
  }
  return value
}

/**
 * Drops what belonged to the conversation that ended, before a `/clear` or a
 * resume goes on under another session id. A note still held belongs to the
 * ended conversation, so it is shown in the transcript instead of being
 * appended to the next one.
 */
async function forget($: Engine, relay: Relay): Promise<void> {
  relay.awaitingOffer?.timer.cancel()
  relay.awaitingOffer = undefined
  relay.lastSeen = undefined
  relay.handled.clear()
  relay.reply = undefined
  relay.sessionId = undefined
  relay.loadedAt = await timeNow($)
  await showHeld($, relay, 'the conversation ended first')
}

/**
 * Marks a main-loop request as streaming, and returns what ends the mark and
 * appends the notes held meanwhile, or left held by an earlier load of the
 * module. It runs when the stream ends and when it is aborted, and acts once,
 * only while this request is still the one marked. Requests in the main loop
 * follow one another, so one starting while another is marked means that one
 * ended unseen; its held notes wait for this reply instead, since appending
 * them now would put them ahead of it.
 */
function startReply($: Engine, relay: Relay, step: Reply, signal: AbortSignal): () => Promise<void> {
  if (relay.reply !== undefined) {
    debug($, `request ${relay.reply.index} of turn ${oneLine(relay.reply.turnId)} ended without closing its stream`)
  }
  const reply: Reply = { turnId: step.turnId, index: step.index }
  relay.reply = reply

  const end = async (): Promise<void> => {
    signal.removeEventListener('abort', onAbort)
    if (relay.reply !== reply) return
    relay.reply = undefined
    if (!relay.mayHold) return
    await flush($, relay).catch((error: unknown) => debug($, `appending held notes failed: ${reasonOf(error)}`))
  }
  const onAbort = (): void => void end()
  signal.addEventListener('abort', onAbort, { once: true })
  return end
}

const modeOf = (value: unknown): Mode | undefined =>
  value === 'append' || value === 'log' ? value : undefined

export const register: Register = (on, options) => {
  // `off`: no hooks, so the reviewer runs untouched.
  const mode = modeOf(options.mode)
  if (mode === undefined) return

  const relay: Relay = {
    mode,
    handled: new Map(),
    warned: new Set(),
    isStatusShown: false,
    lastSeen: undefined,
    awaitingOffer: undefined,
    sessionsWrites: Promise.resolve(),
    loadedAt: undefined,
    sessionId: undefined,
    reply: undefined,
    heldChanges: Promise.resolve(),
    mayHold: true,
  }

  // Fires at each load of the module, a reload included. Notes an earlier
  // load held are appended when the next request ends, or, when the relay
  // now writes to the transcript only, shown there at once.
  on('session.start', async ($, e, next) => {
    relay.loadedAt ??= await timeNow($)
    if (mode === 'log') await showHeld($, relay, 'the relay now writes notes to the transcript only')
    return next(e)
  })

  // The reviewer's writes pass through here because a user-tier hook sits
  // above the built-in tier. Each one is stored; only a note the relay sent
  // on is taken down, and on any failure the write goes on unchanged.
  on('store.set', async ($, e, next) => {
    if (!isReviewer(next.origin)) return next(e)

    // Only reading the write is guarded: a store that fails it fails it once,
    // as it would without the relay.
    const pass = async () => {
      if (isAbandoned(next)) return SETTLED
      relay.loadedAt ??= await timeNow($)
      let value: unknown = e.value
      if (next.budget.remainingMs < APPEND_BUDGET_MS) {
        debug($, `passed a reviewer write on unread, ${Math.round(next.budget.remainingMs)} ms of its budget left`)
      } else {
        try {
          value = await observe($, relay, e.key, e.value, next.signal)
        } catch (error) {
          warn($, relay, 'observe-failed', `reading a reviewer note failed: ${reasonOf(error)}`)
        }
      }
      if (isAbandoned(next)) return SETTLED
      return next(value === e.value ? e : { ...e, value })
    }
    if (e.key !== 'sessions') return pass()

    const stored = relay.sessionsWrites.then(pass)
    relay.sessionsWrites = stored.then(
      () => undefined,
      () => undefined,
    )
    return stored
  })

  // The reviewer reads `sessions` before it writes it again. A read while a
  // write of it waits for an append would see the value from before that
  // write, and a write built from it could put the note back on the band.
  on('store.get', async ($, e, next) => {
    if (e.key !== 'sessions' || !isReviewer(next.origin)) return next(e)
    await relay.sessionsWrites
    if (isAbandoned(next)) return SETTLED
    return next(e)
  })

  // Marks the main loop's model requests while they stream, so a note stored
  // meanwhile is appended after the reply instead of ahead of it. The appends
  // finish before the step's result goes back, so the next request reads them.
  if (mode === 'append') {
    on('turn.step', async function* ($, e, next) {
      if (e.agentId !== undefined) return yield* next(e)
      const end = startReply($, relay, e, next.signal)
      try {
        return yield* next(e)
      } finally {
        await end()
      }
    })
  }

  // The reviewer's own session.end hook, beneath, may write `sessions`, and
  // reading it caches the ending conversation's id; it is dropped again once
  // the chain is done, so the next conversation reads its own.
  on('session.end', async ($, e, next) => {
    await forget($, relay)
    try {
      return await next(e)
    } finally {
      relay.sessionId = undefined
    }
  })
}
