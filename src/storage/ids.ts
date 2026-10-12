/**
 * Unique, sortable record ids.
 *
 * A plain `Date.now()` is not enough: two records written in the same
 * millisecond used to share an id, and because IndexedDB keys are unique by
 * `id` one write silently clobbered the other (automatic saves pruned manual
 * ones). A process-wide sequence fixes that without needing coordination
 * between modules.
 *
 * Ids sort by time first, then by write order, which keeps "newest first"
 * listings stable.
 */

let sequence = 0;

/** `<gameId>:<kind>:<timestamp>:<sequence>` — unique within and across sessions. */
export function nextRecordId(kind: string, gameId: string, now: number = Date.now()): string {
  sequence += 1;
  return `${gameId}:${kind}:${now}:${sequence}`;
}

/** Test helper: makes id generation deterministic again between test cases. */
export function resetIdSequence(): void {
  sequence = 0;
}
