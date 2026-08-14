"use client";

import * as React from "react";

/**
 * Tiny external store.
 *
 * For the handful of pieces of UI state that live outside the React tree and are
 * opened from anywhere: the command palette, the time entry dialog. A context
 * provider would work, but every component that only *triggers* one would then
 * re-render whenever it opened. This keeps the trigger free.
 */
export function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();

  const get = () => state;
  const set = (patch: Partial<T> | ((s: T) => Partial<T>)) => {
    const next = typeof patch === "function" ? (patch as (s: T) => Partial<T>)(state) : patch;
    state = { ...state, ...next };
    listeners.forEach((l) => l());
  };
  const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

  function useStore(): T;
  function useStore<S>(selector: (s: T) => S): S;
  function useStore<S>(selector?: (s: T) => S) {
    return React.useSyncExternalStore(
      subscribe,
      () => (selector ? selector(state) : (state as unknown as S)),
      () => (selector ? selector(initial) : (initial as unknown as S))
    );
  }

  return { get, set, subscribe, useStore };
}
