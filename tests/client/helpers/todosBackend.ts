import { vi } from "vitest";

import {
  PLUGIN_UNAVAILABLE_RESPONSE,
  Role,
  TODO_LIST_NAME_MAX_LENGTH,
  TODO_LIST_WRITE_FIELDS,
  TODO_NOTES_MAX_LENGTH,
  TODO_STATUS_FILTERS,
  TODO_TITLE_MAX_LENGTH,
  TODO_WRITE_FIELDS,
  hasVisibleCharacter,
  isTodoRepeat,
  nextRepeatDueDate,
  repeatAnchorDay,
  sameTodoRepeat,
  type Member,
  type Todo,
  type TodoCompletion,
  type TodoList,
  type TodoRepeat,
  type TodoStatusFilter,
} from "../../../src/shared";
import { isStrictCalendarDate, localDateParts } from "../../../src/shared/householdTime";
import type { PluginCatalogEntry, PluginId, PluginState } from "../../../src/shared/plugins";
import { json } from "./fetchRoutes";

/** The admin PIN the fake `POST /api/auth/verify-pin` accepts. */
export const ADMIN_PIN = "2468";
export const TODAY = "2026-09-22";
export const NOW = Date.parse(`${TODAY}T10:00:00Z`);

function member(
  id: string,
  displayName: string,
  colorKey: Member["colorKey"],
  role: Role,
  lifecycle: Member["lifecycle"] = "active"
): Member {
  return {
    id,
    displayName,
    colorKey,
    role,
    lifecycle,
    createdAt: 0,
    updatedAt: 0,
    celebration: { preset: "confetti" },
  };
}

/** Two active adults, one child and one archived adult. */
export const householdMembers: Member[] = [
  member("alex", "Alex", "blue", Role.child),
  member("blair", "Blair", "pink", Role.parent),
  member("dana", "Dana", "teal", Role.parent),
  member("eli", "Eli", "green", Role.parent, "archived"),
];

export type TodoSeed = Pick<Todo, "id" | "listId" | "title"> & Partial<Todo>;

export interface TodosBackendOptions {
  lists?: { id: string; name: string }[];
  todos?: TodoSeed[];
  members?: Member[];
  language?: "en" | "es";
  /** The household's IANA timezone; UTC when left out. */
  timezone?: string;
  /** Plugin states for `GET /api/plugins`; plugins left out are active. While to-dos is not
   * active its routes answer the lifecycle gate's 503. */
  plugins?: Partial<Record<PluginId, PluginState>>;
  /** Answers a request instead of the fake when it returns a response. */
  intercept?: (key: string, body: unknown) => Response | undefined | Promise<Response | undefined>;
  /** Requests outside the to-dos API, e.g. the calendar read of the Home agenda. */
  other?: (key: string) => Response | undefined;
}

export interface RecordedRequest {
  key: string;
  body: unknown;
}

const PLUGIN_CONTRIBUTIONS: Record<PluginId, PluginCatalogEntry["contributions"]> = {
  "daily-briefing": blank({ routes: ["daily-briefing-api"] }),
  printing: blank({ routes: ["printing-api"], widgets: ["printer-attention"] }),
  weather: blank({ routes: ["weather-api"], widgets: ["weather-pill"] }),
  "time-announcements": blank({ routes: ["time-announcements-api"] }),
  backups: blank({ routes: ["backups-api"] }),
  "network-devices": blank({ routes: ["network-devices-api"] }),
  "meals-recipes": blank({ routes: ["meals-recipes-api"], widgets: ["today-meals"] }),
  reminders: blank({ routes: ["reminders-api"] }),
  "daily-messages": blank({ routes: ["daily-messages-api"] }),
  todos: blank({ routes: ["todos-api"], widgets: ["agenda-todos", "calendar-todos"] }),
};

function blank(
  value: Partial<PluginCatalogEntry["contributions"]>
): PluginCatalogEntry["contributions"] {
  return { routes: [], admin: [], settings: [], widgets: [], services: [], jobs: [], ...value };
}

function catalog(states: Partial<Record<PluginId, PluginState>>): PluginCatalogEntry[] {
  return (Object.keys(PLUGIN_CONTRIBUTIONS) as PluginId[]).map((id) => ({
    id,
    label: `plugins.${id}.label`,
    description: `plugins.${id}.description`,
    trustTier: "first-party",
    contributions: PLUGIN_CONTRIBUTIONS[id],
    requirements: [],
    settingsSchema: [],
    state: states[id] ?? "active",
    operation: null,
    health: { status: "healthy", code: null },
    updatedAt: "2026-09-28T08:00:00.000Z",
    error: null,
  }));
}

/** A request the API refuses, with the status and the body it answers. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string = error
  ) {
    super(message);
  }
}
const invalid = (message: string) => new Refusal(400, "validation_error", message);

/** SQLite's `ORDER BY name COLLATE NOCASE, name`: ASCII letters fold, every other character
 * compares by its UTF-8 bytes, so an accented name sorts after every ASCII one. */
function byNameNoCase(a: { name: string }, b: { name: string }): number {
  const fold = (name: string) => Buffer.from(name.replace(/[A-Z]/g, (c) => c.toLowerCase()));
  return (
    Buffer.compare(fold(a.name), fold(b.name)) ||
    Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
  );
}

/** An in-memory stand-in for the to-dos HTTP API. It follows `src/server/modules/todos` rule by
 * rule, because a laxer fake lets a client bug pass: allow-listed bodies, trimmed and capped
 * labels, strict dates, the adults-only assignee checked only when it changes, repeat rules that
 * need a due date, every listing filter, both orders, idempotent completion that creates the next
 * occurrence of a repeating to-do once, and the lifecycle gate's 503. Seeds are stored as given,
 * without validation. Every request is recorded as `"METHOD /path?query"`.
 */
export function todosBackend(options: TodosBackendOptions = {}) {
  const members = options.members ?? householdMembers;
  const lists = new Map(
    (options.lists ?? []).map((list) => [list.id, { ...list, createdAt: 0, updatedAt: 0 }])
  );
  let sequence = 0;
  const todos = new Map<string, Todo>(
    (options.todos ?? []).map((seed) => [
      seed.id,
      {
        notes: null,
        dueDate: null,
        assigneeMemberId: null,
        repeat: null,
        completedAt: null,
        createdAt: ++sequence,
        updatedAt: sequence,
        ...seed,
      },
    ])
  );
  const requests: RecordedRequest[] = [];
  /** The server's `repeat_anchor_day` and `next_todo_id` columns, which no read returns. */
  const anchorDays = new Map<string, number>();
  const nextTodoIds = new Map<string, string>();

  const view = (list: { id: string; name: string }): TodoList => ({
    id: list.id,
    name: list.name,
    openCount: [...todos.values()].filter(
      (todo) => todo.listId === list.id && todo.completedAt === null
    ).length,
    createdAt: 0,
    updatedAt: 0,
  });

  function fields(body: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw invalid("body must be an object");
    }
    const unsupported = Object.keys(body).filter((key) => !allowed.includes(key));
    if (unsupported.length > 0) throw invalid(`unsupported field(s): ${unsupported.join(", ")}`);
    return body as Record<string, unknown>;
  }
  function label(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== "string") throw invalid(`${field} must be a string`);
    const trimmed = value.trim();
    if (!hasVisibleCharacter(trimmed)) throw invalid(`${field} must not be blank`);
    if (trimmed.length > maxLength) throw invalid(`${field} is too long`);
    return trimmed;
  }
  function notes(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw invalid("notes must be a string or null");
    if (value.length > TODO_NOTES_MAX_LENGTH) throw invalid("notes is too long");
    return value.trim().length === 0 ? null : value;
  }
  function date(value: unknown, field: string): string {
    if (typeof value !== "string" || !isStrictCalendarDate(value)) {
      throw invalid(`${field} must be a strict YYYY-MM-DD`);
    }
    return value;
  }
  const dueDate = (value: unknown) =>
    value === undefined || value === null ? null : date(value, "dueDate");
  function listId(value: unknown): string {
    if (typeof value !== "string") throw invalid("listId must be a string");
    if (!lists.has(value)) throw invalid("unknown list");
    return value;
  }
  function assignee(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw invalid("assigneeMemberId must be a string or null");
    if (!isActiveParent(value)) throw invalid("assignee must be an active parent");
    return value;
  }
  const isActiveParent = (id: string) =>
    members.some(
      (candidate) =>
        candidate.id === id && candidate.lifecycle === "active" && candidate.role === Role.parent
    );
  function repeat(value: unknown): TodoRepeat | null {
    if (value === undefined || value === null) return null;
    if (!isTodoRepeat(value)) throw invalid("repeat must be null or { every, unit }");
    return { every: value.every, unit: value.unit };
  }
  /** Checks that a rule has a due date and stores its anchor day, kept when `sameCycle`. */
  function anchor(id: string, rule: TodoRepeat | null, due: string | null, sameCycle = false) {
    if (rule === null) return void anchorDays.delete(id);
    if (due === null) throw invalid("a repeating to-do needs a due date");
    anchorDays.set(id, (sameCycle ? anchorDays.get(id) : undefined) ?? repeatAnchorDay(due));
  }
  function today(): string {
    const { y, m, d } = localDateParts(Date.now(), options.timezone ?? "UTC");
    return [
      String(y).padStart(4, "0"),
      String(m).padStart(2, "0"),
      String(d).padStart(2, "0"),
    ].join("-");
  }
  /** The server's `createNextOccurrence`. */
  function nextOccurrence(todo: Todo): Todo | null {
    if (todo.repeat === null || todo.dueDate === null || nextTodoIds.has(todo.id)) return null;
    const anchorDay = anchorDays.get(todo.id) ?? repeatAnchorDay(todo.dueDate);
    const due = nextRepeatDueDate(todo.dueDate, todo.repeat, anchorDay, today());
    if (due === null) return null;
    const created: Todo = {
      ...todo,
      id: `todo-${++sequence}`,
      dueDate: due,
      assigneeMemberId:
        todo.assigneeMemberId !== null && isActiveParent(todo.assigneeMemberId)
          ? todo.assigneeMemberId
          : null,
      completedAt: null,
      createdAt: sequence,
      updatedAt: sequence,
    };
    todos.set(created.id, created);
    anchorDays.set(created.id, anchorDay);
    nextTodoIds.set(todo.id, created.id);
    return created;
  }
  const listName = (body: unknown) =>
    label(fields(body, TODO_LIST_WRITE_FIELDS).name, "name", TODO_LIST_NAME_MAX_LENGTH);
  function uniqueName(name: string, exceptId?: string): string {
    if ([...lists.values()].some((list) => list.name === name && list.id !== exceptId)) {
      throw new Refusal(409, "duplicate_name");
    }
    return name;
  }
  function found<T>(value: T | undefined): T {
    if (value === undefined) throw new Refusal(404, "not_found");
    return value;
  }

  function listTodos(query: URLSearchParams): Todo[] {
    // A repeated parameter reaches the server as an array, which no filter accepts.
    const one = (name: string) => {
      const values = query.getAll(name);
      return values.length > 1 ? values : values.at(0);
    };
    const status = one("status") ?? "open";
    if (!TODO_STATUS_FILTERS.includes(status as TodoStatusFilter)) throw invalid("status");
    const bound = (name: string) => (one(name) === undefined ? undefined : date(one(name), name));
    const dueFrom = bound("dueFrom");
    const dueBy = bound("dueBy");
    const matches: ((todo: Todo) => boolean)[] = [
      (todo) => status === "all" || (status === "done") === (todo.completedAt !== null),
      (todo) => dueFrom === undefined || (todo.dueDate !== null && todo.dueDate >= dueFrom),
      (todo) => dueBy === undefined || (todo.dueDate !== null && todo.dueDate <= dueBy),
    ];
    for (const key of ["listId", "assigneeMemberId"] as const) {
      const value = one(key);
      if (value === undefined) continue;
      if (typeof value !== "string") throw invalid(`${key} must be given once`);
      matches.push((todo) => todo[key] === value);
    }
    return [...todos.values()]
      .filter((todo) => matches.every((match) => match(todo)))
      .sort(
        (a, b) =>
          Number(a.completedAt !== null) - Number(b.completedAt !== null) ||
          Number(a.dueDate === null) - Number(b.dueDate === null) ||
          (a.dueDate ?? "").localeCompare(b.dueDate ?? "") ||
          a.createdAt - b.createdAt ||
          a.id.localeCompare(b.id)
      );
  }

  function answerTodos(method: string, url: URL, body: unknown): Response {
    const path = url.pathname;
    if ((options.plugins?.todos ?? "active") !== "active") {
      return json(PLUGIN_UNAVAILABLE_RESPONSE, 503);
    }

    if (path === "/api/todos/lists") {
      if (method === "GET") return json([...lists.values()].sort(byNameNoCase).map(view));
      const created = {
        name: uniqueName(listName(body)),
        id: `list-${++sequence}`,
        createdAt: 0,
        updatedAt: 0,
      };
      lists.set(created.id, created);
      return json(view(created), 201);
    }
    const listMatch = /^\/api\/todos\/lists\/([^/]+)$/.exec(path);
    if (listMatch) {
      const id = decodeURIComponent(listMatch[1]);
      if (method === "DELETE") {
        found(lists.get(id));
        lists.delete(id);
        for (const todo of [...todos.values()]) if (todo.listId === id) todos.delete(todo.id);
        return new Response(null, { status: 204 });
      }
      const name = listName(body);
      const list = found(lists.get(id));
      list.name = uniqueName(name, id);
      return json(view(list));
    }

    if (path === "/api/todos") {
      if (method === "GET") return json(listTodos(url.searchParams));
      const input = fields(body, TODO_WRITE_FIELDS);
      const created: Todo = {
        title: label(input.title, "title", TODO_TITLE_MAX_LENGTH),
        notes: notes(input.notes),
        dueDate: dueDate(input.dueDate),
        listId: listId(input.listId),
        assigneeMemberId: assignee(input.assigneeMemberId),
        repeat: repeat(input.repeat),
        id: `todo-${++sequence}`,
        completedAt: null,
        createdAt: sequence,
        updatedAt: sequence,
      };
      anchor(created.id, created.repeat, created.dueDate);
      todos.set(created.id, created);
      return json(created, 201);
    }
    const completionMatch = /^\/api\/todos\/([^/]+)\/completion$/.exec(path);
    if (completionMatch) {
      const todo = found(todos.get(decodeURIComponent(completionMatch[1])));
      if (method === "DELETE") {
        todo.completedAt = null;
        return json(todo);
      }
      const completedNow = todo.completedAt === null;
      todo.completedAt ??= NOW;
      const completion: TodoCompletion = {
        ...todo,
        nextOccurrence: completedNow ? nextOccurrence(todo) : null,
      };
      return json(completion);
    }
    const todoMatch = /^\/api\/todos\/([^/]+)$/.exec(path);
    if (todoMatch) {
      const id = decodeURIComponent(todoMatch[1]);
      if (method === "GET") return json(found(todos.get(id)));
      if (method === "DELETE") {
        found(todos.get(id));
        todos.delete(id);
        return new Response(null, { status: 204 });
      }
      const input = fields(body, TODO_WRITE_FIELDS);
      if (Object.keys(input).length === 0) throw invalid("body must name at least one field");
      const todo = found(todos.get(id));
      const next: Todo = {
        ...todo,
        ...("title" in input && { title: label(input.title, "title", TODO_TITLE_MAX_LENGTH) }),
        ...("notes" in input && { notes: notes(input.notes) }),
        ...("dueDate" in input && { dueDate: dueDate(input.dueDate) }),
        ...("listId" in input && { listId: listId(input.listId) }),
        // An assignee the request leaves as stored is not checked again (TODOS-INV-05).
        ...("assigneeMemberId" in input &&
          input.assigneeMemberId !== todo.assigneeMemberId && {
            assigneeMemberId: assignee(input.assigneeMemberId),
          }),
        ...("repeat" in input && { repeat: repeat(input.repeat) }),
      };
      anchor(
        id,
        next.repeat,
        next.dueDate,
        next.dueDate === todo.dueDate && sameTodoRepeat(next.repeat, todo.repeat)
      );
      Object.assign(todo, next, { updatedAt: ++sequence });
      return json(todo);
    }
    throw new Error(`unexpected fetch: ${method} ${path}${url.search}`);
  }

  function answer(method: string, url: URL, body: unknown): Response {
    const path = url.pathname;
    if (method === "GET" && path === "/api/settings")
      return json({
        locale: {
          timezone: options.timezone ?? "UTC",
          language: options.language ?? "en",
          weekStartDay: 1,
        },
        weather: { lat: null, lon: null, label: null },
      });
    if (method === "GET" && path === "/api/plugins")
      return json({ plugins: catalog(options.plugins ?? {}) });
    if (method === "GET" && path === "/api/members") return json(members);
    if (method === "POST" && path === "/api/auth/verify-pin")
      return json({ match: (body as { pin?: unknown } | undefined)?.pin === ADMIN_PIN });
    try {
      return answerTodos(method, url, body);
    } catch (refusal) {
      if (!(refusal instanceof Refusal)) throw refusal;
      return json({ error: refusal.error, message: refusal.message }, refusal.status);
    }
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}${url.search}`;
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ key, body });
    const intercepted = await options.intercept?.(key, body);
    if (intercepted) return intercepted;
    const other = options.other?.(key);
    if (other) return other;
    return answer(method, url, body);
  });
  vi.stubGlobal("fetch", fetchMock);

  return {
    requests,
    /** Recorded request keys, optionally only those starting with `prefix`. */
    keys: (prefix = "") => requests.map(({ key }) => key).filter((key) => key.startsWith(prefix)),
    /** Bodies of the recorded requests with exactly this key. */
    bodies: (key: string) => requests.filter((request) => request.key === key).map((r) => r.body),
    todo: (id: string) => todos.get(id),
    lists,
    todos,
  };
}
