import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { apiFetch, jsonRequest, readJson } from "@/lib/api";
import type { Member, Todo, TodoCreate, TodoList, TodoPatch } from "../../shared";
import { listsInReadingOrder } from "./todo-presentation";
import {
  LISTS_URL,
  TODOS_URL,
  completionUrl,
  listUrl,
  todoUrl,
  todosErrorKey,
  todosUrl,
} from "./todos-api";
import { usePendingIds } from "./usePendingIds";

/** The outcome of a write: `null` when it was saved, otherwise the copy that says why not. */
export type WriteResult = MessageKey | null;

export interface TodosWorkspace {
  /** Every list in reading order; null until the first successful read. */
  lists: TodoList[] | null;
  /** All members, archived ones included, so a stale assignee still has a name. */
  members: Member[];
  selectedList: TodoList | null;
  /** Open to-dos of the selected list in API order; null while they load. */
  open: Todo[] | null;
  doneExpanded: boolean;
  /** Done to-dos of the selected list; null while collapsed or loading. */
  done: Todo[] | null;
  loadError: MessageKey | null;
  itemsError: MessageKey | null;
  /** To-dos with a completion request in flight. */
  pendingIds: ReadonlySet<string>;
  retryLoad(): void;
  retryItems(): void;
  selectList(listId: string): void;
  toggleDone(): void;
  /** How many to-dos, done ones included, a list holds; null when the read fails. */
  countTodos(listId: string): Promise<number | null>;
  createList(name: string): Promise<WriteResult>;
  renameList(listId: string, name: string): Promise<WriteResult>;
  deleteList(listId: string): Promise<WriteResult>;
  createTodo(input: TodoCreate): Promise<WriteResult>;
  editTodo(todoId: string, patch: TodoPatch): Promise<WriteResult>;
  deleteTodo(todoId: string): Promise<WriteResult>;
  setCompleted(todo: Todo, completed: boolean): Promise<WriteResult>;
}

export function useTodosWorkspace(): TodosWorkspace {
  const { language } = useTranslation();
  const [lists, setLists] = useState<TodoList[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState<Todo[] | null>(null);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [done, setDone] = useState<Todo[] | null>(null);
  const [loadError, setLoadError] = useState<MessageKey | null>(null);
  const [itemsError, setItemsError] = useState<MessageKey | null>(null);
  const [pendingIds, trackPending] = usePendingIds();
  // Mirrors of state read by callbacks that must not wait for the next render.
  const selectedRef = useRef<string | null>(null);
  const doneExpandedRef = useRef(false);
  const languageRef = useRef(language);
  useEffect(() => {
    languageRef.current = language;
  }, [language]);
  const orderedLists = useMemo(
    () => lists && listsInReadingOrder(lists, language),
    [lists, language]
  );
  // A slow read of a list the family already left must not overwrite the list on screen.
  const itemsGeneration = useRef(0);

  const loadItems = useCallback(async (listId: string | null) => {
    const generation = ++itemsGeneration.current;
    if (listId === null) {
      setOpen(null);
      setDone(null);
      return;
    }
    try {
      const [nextOpen, nextDone] = await Promise.all([
        readJson<Todo[]>(todosUrl({ listId, status: "open" })),
        doneExpandedRef.current
          ? readJson<Todo[]>(todosUrl({ listId, status: "done" }))
          : Promise.resolve(null),
      ]);
      if (generation !== itemsGeneration.current) return;
      setOpen(nextOpen);
      setDone(nextDone);
      setItemsError(null);
    } catch (error) {
      if (generation === itemsGeneration.current)
        setItemsError(todosErrorKey(error, "todos.error"));
    }
  }, []);

  /** Makes `listId` the selected list, collapsed and with nothing read yet. */
  const resetSelection = useCallback((listId: string | null) => {
    selectedRef.current = listId;
    doneExpandedRef.current = false;
    setSelectedId(listId);
    setDoneExpanded(false);
    setOpen(null);
    setDone(null);
  }, []);

  /** Reads the lists, keeps the selection when its list still exists and reads that list. */
  const refresh = useCallback(
    async (preferredListId?: string) => {
      try {
        const next = await readJson<TodoList[]>(LISTS_URL);
        const wanted = preferredListId ?? selectedRef.current;
        // Without a list to keep, the first one the family reads is selected.
        const first = listsInReadingOrder(next, languageRef.current).at(0);
        const selected = (next.find((list) => list.id === wanted) ?? first)?.id ?? null;
        if (selected !== selectedRef.current) resetSelection(selected);
        setLists(next);
        setLoadError(null);
        await loadItems(selected);
      } catch (error) {
        setLoadError(todosErrorKey(error, "todos.error"));
      }
    },
    [loadItems, resetSelection]
  );

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [, nextMembers] = await Promise.all([
        refresh(),
        readJson<Member[]>("/api/members?lifecycle=all"),
      ]);
      setMembers(nextMembers);
    } catch (error) {
      setLoadError(todosErrorKey(error, "todos.error"));
    }
  }, [refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectList = useCallback(
    (listId: string) => {
      resetSelection(listId);
      setItemsError(null);
      void loadItems(listId);
    },
    [loadItems, resetSelection]
  );

  const toggleDone = useCallback(() => {
    const expanded = !doneExpandedRef.current;
    doneExpandedRef.current = expanded;
    setDoneExpanded(expanded);
    if (expanded) void loadItems(selectedRef.current);
    else setDone(null);
  }, [loadItems]);

  /** Runs a write, then reads everything again. The action may name the list to select. */
  const write = useCallback(
    async (action: () => Promise<string | undefined>): Promise<WriteResult> => {
      let preferredListId: string | undefined;
      try {
        preferredListId = await action();
      } catch (error) {
        return todosErrorKey(error, "todos.actionError");
      }
      await refresh(preferredListId);
      return null;
    },
    [refresh]
  );

  const send = (url: string, method: string, body?: unknown) =>
    write(async () => {
      await apiFetch(url, body === undefined ? { method } : jsonRequest(method, body));
      return undefined;
    });

  return {
    lists: orderedLists,
    members,
    selectedList: lists?.find((list) => list.id === selectedId) ?? null,
    open,
    doneExpanded,
    done,
    loadError,
    itemsError,
    pendingIds,
    retryLoad: () => void load(),
    retryItems: () => void loadItems(selectedRef.current),
    selectList,
    toggleDone,
    countTodos: async (listId) => {
      try {
        return (await readJson<Todo[]>(todosUrl({ listId, status: "all" }))).length;
      } catch {
        return null;
      }
    },
    // The new list becomes the selected one.
    createList: (name) =>
      write(async () => (await readJson<TodoList>(LISTS_URL, jsonRequest("POST", { name }))).id),
    renameList: (listId, name) => send(listUrl(listId), "PATCH", { name }),
    deleteList: (listId) => send(listUrl(listId), "DELETE"),
    createTodo: (input) => send(TODOS_URL, "POST", input),
    editTodo: (todoId, patch) => send(todoUrl(todoId), "PATCH", patch),
    deleteTodo: (todoId) => send(todoUrl(todoId), "DELETE"),
    setCompleted: (todo, completed) =>
      trackPending(todo.id, () => send(completionUrl(todo.id), completed ? "POST" : "DELETE")),
  };
}
