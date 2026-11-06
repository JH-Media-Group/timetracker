/** PATCH omits unchanged notes but sends an explicit empty string to clear. */
export function editedTimeEntryNotes(value: string, existing?: { notes?: string | null }): string | undefined {
  const normalized = value.trim();
  if (existing) return normalized === (existing.notes ?? "").trim() ? undefined : normalized;
  return normalized || undefined;
}
