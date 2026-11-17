/**
 * The note the You should know reviewer shows, as heads-up-relay reads it from
 * the reviewer's stored `sessions` value.
 */
export type ReviewerNote = {
  readonly line: string
  readonly tag: string
  /** False when the entry carried no tag and `tag` is the default. */
  readonly isTagged: boolean
  readonly explanation: string
  /** When the reviewer showed it, in milliseconds since the epoch; absent when the entry has no time. */
  readonly shownAt?: number
  readonly reviewedTurn?: string
}

/** A note held until Claude's reply ends, with the conversation it was shown in. */
export type HeldNote = ReviewerNote & {
  readonly sessionId: string
}

declare module 'claude-code' {
  interface PluginState {
    'heads-up-relay': {
      /**
       * Notes taken off the band while Claude's reply streamed, in the order
       * shown, to append once it ends. Held here rather than in the module so
       * a reload of the module keeps them; one shown in another conversation
       * is written to the transcript instead.
       */
      held: readonly HeldNote[]
    }
  }
}
