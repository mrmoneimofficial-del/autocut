'use client'

import { create } from 'zustand'

/**
 * High-frequency playhead state, kept OUT of the main studio store so 60fps
 * updates never re-render the component tree. The canvas timeline subscribes
 * imperatively; the player drives it.
 */
interface PlayheadStore {
  ms: number // position on the ORIGINAL timeline
  playing: boolean
  set: (ms: number, playing?: boolean) => void
}

export const usePlayhead = create<PlayheadStore>((set) => ({
  ms: 0,
  playing: false,
  set: (ms, playing) => set((s) => (playing === undefined ? { ms } : { ms, playing })),
}))
