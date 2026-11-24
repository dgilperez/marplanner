import type { MessageKey } from "@/i18n/messages";
import { ApiError } from "@/lib/api";
import { PLUGIN_UNAVAILABLE_RESPONSE, type TodoStatusFilter } from "../../shared";

export const LISTS_URL = "/api/todos/lists";
export const TODOS_URL = "/api/todos";

export const listUrl = (listId: string) => `${LISTS_URL}/${encodeURIComponent(listId)}`;
export const todoUrl = (todoId: string) => `${TODOS_URL}/${encodeURIComponent(todoId)}`;
export const completionUrl = (todoId: string) => `${todoUrl(todoId)}/completion`;

/** The listing URL for the given filters. `dueFrom` and `dueBy` keep to-dos due on or after and on
 * or before their dates. */
export function todosUrl(filters: {
  listId?: string;
  status: TodoStatusFilter;
  dueFrom?: string;
  dueBy?: string;
}): string {
  return `${TODOS_URL}?${new URLSearchParams(filters)}`;
}

/** Copy for a failed to-dos request, chosen by the API's stable error code. */
export function todosErrorKey(error: unknown, fallback: MessageKey): MessageKey {
  if (!(error instanceof ApiError)) return fallback;
  if (error.code === PLUGIN_UNAVAILABLE_RESPONSE.code) return "todos.unavailable";
  if (error.code === "duplicate_name") return "todos.lists.duplicateName";
  return fallback;
}
