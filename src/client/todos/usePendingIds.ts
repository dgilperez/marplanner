import { useCallback, useState } from "react";

/** The ids with a request in flight, so their controls can be disabled against a second tap.
 * `track` marks an id for as long as `work` runs, also when it rejects. */
export function usePendingIds(): [
  pendingIds: ReadonlySet<string>,
  track: <T>(id: string, work: () => Promise<T>) => Promise<T>,
] {
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const track = useCallback(async <T>(id: string, work: () => Promise<T>): Promise<T> => {
    setPendingIds((current) => new Set(current).add(id));
    try {
      return await work();
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, []);
  return [pendingIds, track];
}
