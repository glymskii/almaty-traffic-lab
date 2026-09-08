/** Fail fast on a broken cross-reference. Networks are contracts-validated upstream (see data/loadNetwork.ts); this guards internal invariants, not user input. */
export function mustGet<T>(map: ReadonlyMap<string, T>, id: string, what: string): T {
  const value = map.get(id);
  if (!value) throw new Error(`${what} ${id} not found`);
  return value;
}
