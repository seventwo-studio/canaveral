import type { Resources } from './consumers.ts';
import { ServiceError } from './errors.ts';

export type PlacementScore = readonly [dominant: number, total: number];
const keys = ['cpu', 'memoryMiB', 'diskGiB'] as const;

/** Rank only already-eligible, fitting candidates, including the pending reservation.
 * Use the physical/configured capacity minimum; this score grants no authority
 * and never releases or changes a reservation.
 */
export function placementScore(capacity: Resources, used: Resources, request: Resources): PlacementScore {
  const shares = keys.map(key => {
    if (!Number.isSafeInteger(capacity[key]) || capacity[key] <= 0 ||
        !Number.isSafeInteger(used[key]) || used[key] < 0 ||
        !Number.isSafeInteger(request[key]) || request[key] <= 0 ||
        !Number.isSafeInteger(used[key] + request[key]) || used[key] + request[key] > capacity[key]) {
      throw new ServiceError('Placement requires a valid fitting reservation.', 503, { retryable: false });
    }
    return (used[key] + request[key]) / capacity[key];
  });
  return [Math.max(...shares), shares.reduce((sum, share) => sum + share, 0)];
}

export function comparePlacementScore(a: PlacementScore, b: PlacementScore): number {
  return a[0] - b[0] || a[1] - b[1];
}
