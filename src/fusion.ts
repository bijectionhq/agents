/** Fuse vector and lexical candidates by reciprocal rank.
 * A missing lexical result contributes zero. First occurrences own their rank;
 * ties keep first discovery order (vector, then lexical).
 */
// concave:invariant hybrid-rank-identity
// Every vector and lexical identity competes before truncation; missing matches
// add no score, first ranks own duplicates, and ties keep discovery order.
export function fuseRanks<Id extends string>(
  vectorIds: readonly Id[],
  lexicalIds: readonly (Id | undefined)[],
): Id[] {
  const candidates = new Map<Id, { id: Id; score: number; rank: number }>();
  for (const ids of [vectorIds, lexicalIds]) {
    const seen = new Set<Id>();
    for (const [rank, id] of ids.entries()) {
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      let candidate = candidates.get(id);
      if (!candidate) {
        candidate = { id, score: 0, rank: candidates.size };
        candidates.set(id, candidate);
      }
      candidate.score += 1 / (rank + 10);
    }
  }
  const ranked = [...candidates.values()];
  ranked.sort((a, b) => b.score - a.score || a.rank - b.rank);
  return ranked.map(({ id }) => id);
}
