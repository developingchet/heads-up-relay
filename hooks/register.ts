import type { EngineInterface as Engine, Origin, Register, Timer } from 'claude-code'
import {
  REVIEWER,
  type ReviewerNote,
  contextText,
  hasOffer,
  noteKey,
  oneLine,
  shownNote,
  transcriptText,
  withoutView,
} from './note'

/**
 * The reviewer's private store layout this relay reads was checked against
 * this Claude Code release; another release raises a one-time reminder.
 */
const CHECKED_RELEASE = '2.1.325'

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
 * one that hangs.
 */
const APPEND_WAIT_MS = 5_000

type Mode = 'append' | 'log'

/** A note taken off the band while Claude's reply streamed, to append once it ends. */
type HeldNote = { readonly note: ReviewerNote; readonly turn: string }

/** One main-loop model request, from its start until its stream ends or is aborted. */
type Reply = { readonly turnId: string; readonly index: number }

/** What one load of the module remembers between the reviewer's writes. */
type Relay = {
  readonly mode: Mode
  /**
   * Each note handled, by key: whether it is now in the main conversation.
   * Every write that carries the note waits on the same answer.
   */
  readonly handled: Map<string, Promise<boolean>>
  /** Main-loop turns of this session that started while the relay was loaded. */
  readonly sessionTurns: Set<string>
  readonly warned: Set<string>
  isStatusShown: boolean
  lastSeen: string | undefined
  awaitingOffer: { readonly line: string; readonly timer: Timer } | undefined
  /**
   * The reviewer's `sessions` writes, one after another: a write held for an
   * append is stored before any write the reviewer made after it.
   */
  sessionsWrites: Promise<void>
  /** The main-loop model request streaming now. */
  reply: Reply | undefined
  held: readonly HeldNote[]
}

type WarnOptions = {
  /** False for a warning about the layout that does not stop the note. */
  readonly raisesStatus?: boolean
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

/** Writes to the debug log, never throwing: it is the last place to report to. */
function debug($: Engine, text: string): void {
  try {
    $.ui.log(`${$.plugin.name}: ${text}`, { to: 'debug' })
  } catch {
    // Nothing is left to report a failing debug log to.
  }
}

/**
 * Says, once per kind, that something is wrong, and for a note that did not
 * get through keeps the status line up until a later note does.
 */
function warn($: Engine, relay: Relay, id: string, text: string, { raisesStatus = true }: WarnOptions = {}): void {
  debug($, text)
  try {
    if (raisesStatus && !relay.isStatusShown) {
      relay.isStatusShown = true
      $.ui.status(`${$.plugin.name}: notes not forwarded, see transcript`)
    }
    if (relay.warned.has(id)) return
    relay.warned.add(id)
    $.ui.log(`⚠ ${$.plugin.name}: ${text}`)
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

/**
 * Puts one transcript line where the person sees what the main agent was
 * given, and clears the status line.
 */
function receipt($: Engine, relay: Relay, note: ReviewerNote, turn: string, isLate = false): void {
  try {
    debug($, `forwarded a ${oneLine(note.tag)} note about turn ${oneLine(turn)}`)
    $.ui.log(`${$.plugin.name}: sent Claude a ${oneLine(note.tag)} note${isLate ? ' after all' : ''}: ${oneLine(note.line)}`)
    delivered($, relay)
  } catch (error) {
    debug($, `reporting a forwarded note failed: ${reasonOf(error)}`)
  }
}

/** The append's refusal, or `undefined` once the row is stored. */
const appendRow = ($: Engine, note: ReviewerNote): Promise<string | undefined> =>
  $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text: contextText(note) }] } })
    .then(stored => (stored.deny === undefined ? undefined : oneLine(String(stored.deny))), reasonOf)

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
 * Stores the note in the main conversation as a user-role row the person does
 * not see as typed. It starts no turn: a running turn reads it from its next
 * request, an idle session from the next prompt. Returns the refusal, if any.
 * An append still pending at the deadline counts as refused for this write;
 * `onLate` runs if it is stored after all.
 */
async function append($: Engine, note: ReviewerNote, onLate: () => void): Promise<string | undefined> {
  const stored = appendRow($, note)
  const limit = deadline($)
  const outcome = await Promise.race([stored, limit.elapsed])
  limit.cancel()
  if (outcome !== 'timed out') return outcome

  void stored.then(refusal => {
    if (refusal === undefined) onLate()
  })
  return `no answer within ${APPEND_WAIT_MS / 1000} s`
}

async function deliver($: Engine, relay: Relay, key: string, note: ReviewerNote): Promise<boolean> {
  // Only a note about a turn this session ran while the relay was loaded is
  // sent on; one from before a reload, or about any other turn, is left alone.
  const turn = note.reviewedTurn
  if (turn === undefined) {
    warn($, relay, 'turn-missing', `the reviewer showed a note without the turn it reviewed, so it was not sent: ${quoted(note.line)}`)
    return false
  }
  if (!relay.sessionTurns.has(turn)) {
    debug($, `skipped a note about turn ${oneLine(turn)}, not one of this session's`)
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
    relay.held = [...relay.held, { note, turn }]
    debug($, `holding a ${oneLine(note.tag)} note until Claude's reply ends`)
    return true
  }

  // A late append is in the conversation after all: the reviewer's next
  // write of the note takes it off the band.
  const refusal = await append($, note, () => {
    relay.handled.set(key, Promise.resolve(true))
    receipt($, relay, note, turn, true)
  })
  if (refusal !== undefined) {
    warn($, relay, 'append-refused', `a note could not be added to the conversation (${refusal}); the reviewer still shows it.`)
    return false
  }
  receipt($, relay, note, turn)
  return true
}

/**
 * Writes a held note in full to the transcript: it is off the band already,
 * so this is where the person still sees it.
 */
function showInstead($: Engine, relay: Relay, note: ReviewerNote, reason: string): void {
  warn($, relay, 'held-not-sent', `a note held until Claude's reply ended was not added to the conversation (${reason}); it is shown here instead.`)
  try {
    $.ui.log(transcriptText(note))
  } catch (error) {
    debug($, `showing a held note failed: ${reasonOf(error)}`)
  }
}

/** Appends the notes held while Claude's reply streamed, in the order they came. */
async function flush($: Engine, relay: Relay): Promise<void> {
  const notes = relay.held
  relay.held = []
  for (const { note, turn } of notes) {
    const refusal = await append($, note, () => receipt($, relay, note, turn, true))
    if (refusal === undefined) receipt($, relay, note, turn)
    else showInstead($, relay, note, refusal)
  }
}

/**
 * Whether the note is in the main conversation, delivering it the first time.
 * A write whose dispatch was already abandoned is passed on as it came, so
 * the note stays on the band, and a later write may still deliver it; so may
 * one after a delivery that failed outright.
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

  const answer = deliver($, relay, key, note).catch((error: unknown) => {
    relay.handled.delete(key)
    warn($, relay, 'deliver-failed', `forwarding a note failed: ${reasonOf(error)}`)
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
  const sessionId = await $.session.id()
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
 * Drops what belonged to the conversation that ended, before a `/clear` starts
 * another. A note still held belongs to the ended conversation, so it is shown
 * in the transcript instead of being appended to the next one.
 */
function forget($: Engine, relay: Relay): void {
  const notes = relay.held
  relay.held = []
  for (const { note } of notes) showInstead($, relay, note, 'the conversation ended first')
  relay.awaitingOffer?.timer.cancel()
  relay.awaitingOffer = undefined
  relay.lastSeen = undefined
  relay.sessionTurns.clear()
  relay.handled.clear()
}

/**
 * Marks a main-loop request as streaming, and returns what ends the mark and
 * appends the notes held meanwhile. It runs when the stream ends and when it
 * is aborted, and acts once, only while this request is still the one
 * marked. Requests in the main loop follow one another, so one starting while
 * another is marked means that one ended unseen; its held notes wait for this
 * reply instead, since appending them now would put them ahead of it.
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
    if (relay.held.length === 0) return
    await flush($, relay).catch((error: unknown) => debug($, `appending held notes failed: ${reasonOf(error)}`))
  }
  const onAbort = (): void => void end()
  signal.addEventListener('abort', onAbort, { once: true })
  return end
}

async function remindAfterUpdate($: Engine): Promise<void> {
  const { version } = await $.session.version()
  if (version === CHECKED_RELEASE) return
  if ((await $.store.get('remindedRelease')) === version) return

  await $.store.set('remindedRelease', version)
  $.ui.log(
    `${$.plugin.name}: this is Claude Code ${version}; the relay reads the You should know reviewer's private store, checked on ${CHECKED_RELEASE}. Confirm the next note reaches the conversation.`,
  )
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
    sessionTurns: new Set(),
    warned: new Set(),
    isStatusShown: false,
    lastSeen: undefined,
    awaitingOffer: undefined,
    sessionsWrites: Promise.resolve(),
    reply: undefined,
    held: [],
  }

  // The reviewer's writes pass through here because a user-tier hook sits
  // above the built-in tier. Each one is stored; only a note the relay sent
  // on is taken down, and on any failure the write goes on unchanged.
  on('store.set', async ($, e, next) => {
    if (!isReviewer(next.origin)) return next(e)

    // Only reading the write is guarded: a store that fails it fails it once,
    // as it would without the relay.
    const pass = async () => {
      if (next.signal.aborted) return next(e)
      let value: unknown = e.value
      try {
        value = await observe($, relay, e.key, e.value, next.signal)
      } catch (error) {
        warn($, relay, 'observe-failed', `reading a reviewer note failed: ${reasonOf(error)}`)
      }
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

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) relay.sessionTurns.add(e.turnId)
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

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await remindAfterUpdate($)
    } catch (error) {
      debug($, `release check failed: ${reasonOf(error)}`)
    }
    return started
  })

  on('session.end', ($, e, next) => {
    forget($, relay)
    return next(e)
  })
}
