import type { TimeEntry } from "@/lib/types";
import { crossesMidnight, instantAt, nextIsoDay } from "@/lib/format";
import { dayIn } from "@/domain/calendar";

type ExistingClock = Pick<TimeEntry, "spentOn" | "durationSeconds"> & Partial<Pick<TimeEntry, "timerStartedAt" | "startedAt">>;

export interface TimeEntryClockInput {
  existing?: ExistingClock;
  initialStartMinutes?: number;
  initialEndMinutes?: number;
  spentOn: string;
  startMinutes: number | null;
  endMinutes: number | null;
  durationSeconds: number;
  timezone: string;
}

export interface TimeEntryClockValues {
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
}

/**
 * Build only the clock fields an entry save is entitled to change.
 *
 * A running entry's timestamps are live state, not presentation fields. Sending
 * them again during a notes-only edit lets a stale calendar date move the start
 * instant backwards by a day, inflating a short timer to more than 24 hours.
 * Existing timestamps are therefore omitted unless the date or a clock field
 * actually changed. New entries still receive the complete clock shape.
 */
export function timeEntryClockValues(input: TimeEntryClockInput): TimeEntryClockValues {
  const startChanged = input.startMinutes !== (input.initialStartMinutes ?? null);
  const endChanged = input.endMinutes !== (input.initialEndMinutes ?? null);
  const clockChanged = !input.existing || input.spentOn !== input.existing.spentOn || startChanged || endChanged;

  const clockDate = input.existing?.timerStartedAt && input.existing.startedAt
    ? dayIn(input.timezone, new Date(input.existing.startedAt)) : input.spentOn;
  const startedAt = input.startMinutes == null
    ? undefined
    : instantAt(clockDate, input.startMinutes, input.timezone);
  const endedAt = input.endMinutes == null
    ? undefined
    : instantAt(
        input.startMinutes != null && crossesMidnight(input.startMinutes, input.endMinutes)
          ? nextIsoDay(input.spentOn)
          : input.spentOn,
        input.endMinutes,
        input.timezone
      );

  // A running duration is banked time plus a live segment, not the rounded
  // duration printed by the form. Only a changed start may rebase that clock.
  // Moving its booking date alone must not add or remove a day of elapsed time.
  if (input.existing?.timerStartedAt) {
    return startChanged && startedAt ? { startedAt } : {};
  }

  const seconds = clockChanged && startedAt && endedAt
    ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000))
    : input.durationSeconds;

  return {
    ...(clockChanged && startedAt ? { startedAt } : {}),
    ...(clockChanged && endedAt ? { endedAt } : {}),
    ...(!input.existing || seconds !== input.existing.durationSeconds ? { durationSeconds: seconds } : {}),
  };
}
