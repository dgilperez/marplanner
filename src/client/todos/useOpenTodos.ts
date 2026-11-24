import { useCallback, useEffect, useRef, useState } from "react";

import type { MessageKey } from "@/i18n/messages";
import { apiFetch, readJson } from "@/lib/api";
import type { Todo } from "../../shared";
import { completionUrl, todosErrorKey } from "./todos-api";
import { usePendingIds } from "./usePendingIds";

export interface OpenTodos {
  /** The answer of the latest read; null until the first one arrives. */
  todos: Todo[] | null;
  readFailed: boolean;
  writeError: MessageKey | null;
  /** To-dos with a completion request in flight. */
  pendingIds: ReadonlySet<string>;
  reload(): void;
  /** Marks the to-do done, drops it from `todos` and reads again. */
  complete(todo: Todo): Promise<void>;
}

/** A listing of open to-dos that a surface outside the To-dos page shows and completes from.
 * It reads `url` on mount, for each new `url`, when the tablet becomes visible again and after a
 * completion; the read after a completion is what brings in the next occurrence of a repeating
 * to-do. */
export function useOpenTodos(url: string): OpenTodos {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [answered, setAnswered] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [writeError, setWriteError] = useState<MessageKey | null>(null);
  const [pendingIds, trackPending] = usePendingIds();
  // A slow read must not overwrite the answer of a later one.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const read = await readJson<Todo[]>(url);
      if (current !== generation.current) return;
      setTodos(read);
      setAnswered(true);
      setReadFailed(false);
    } catch {
      if (current === generation.current) setReadFailed(true);
    }
  }, [url]);

  useEffect(() => {
    void load();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [load]);

  const complete = useCallback(
    async (todo: Todo) => {
      setWriteError(null);
      try {
        await trackPending(todo.id, () => apiFetch(completionUrl(todo.id), { method: "POST" }));
        setTodos((current) => current.filter((item) => item.id !== todo.id));
        void load();
      } catch (error) {
        setWriteError(todosErrorKey(error, "todos.actionError"));
      }
    },
    [load, trackPending]
  );

  return {
    todos: answered ? todos : null,
    readFailed,
    writeError,
    pendingIds,
    reload: () => void load(),
    complete,
  };
}
