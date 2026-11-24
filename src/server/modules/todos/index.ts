import { randomUUID } from "node:crypto";
import { getDb, isStrictCalendarDate, listActiveMembers, todayInHouseholdTz } from "../../host-api";
import {
  TODO_LIST_NAME_MAX_LENGTH,
  TODO_LIST_WRITE_FIELDS,
  TODO_NOTES_MAX_LENGTH,
  TODO_REPEAT_EVERY_MAX,
  TODO_REPEAT_EVERY_MIN,
  TODO_REPEAT_UNITS,
  TODO_STATUS_FILTERS,
  TODO_TITLE_MAX_LENGTH,
  TODO_WRITE_FIELDS,
  hasVisibleCharacter,
  isTodoRepeat,
  nextRepeatDueDate,
  repeatAnchorDay,
  sameTodoRepeat,
} from "../../../shared";
import type {
  Todo,
  TodoCompletion,
  TodoList,
  TodoRepeat,
  TodoRepeatUnit,
  TodoStatusFilter,
} from "../../../shared";

export class TodoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoValidationError";
  }
}

export class TodoNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoNotFoundError";
  }
}

export class TodoListNameConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoListNameConflictError";
  }
}

type TodoListRow = {
  id: string;
  name: string;
  open_count: number;
  created_at: number;
  updated_at: number;
};

type TodoRow = {
  id: string;
  list_id: string;
  title: string;
  notes: string | null;
  due_date: string | null;
  assignee_member_id: string | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
  repeat_every: number | null;
  repeat_unit: TodoRepeatUnit | null;
  /** The day of the month a month or year rule returns to; set whenever the rule is. */
  repeat_anchor_day: number | null;
  /** The occurrence this to-do created when it was completed; set at most once. */
  next_todo_id: string | null;
};

const LIST_SELECT = `SELECT id, name, created_at, updated_at,
    (SELECT COUNT(*) FROM todo_items
      WHERE todo_items.list_id = todo_lists.id AND todo_items.completed_at IS NULL) AS open_count
  FROM todo_lists`;

const TODO_SELECT = `SELECT id, list_id, title, notes, due_date, assignee_member_id, completed_at,
    created_at, updated_at, repeat_every, repeat_unit, repeat_anchor_day, next_todo_id
  FROM todo_items`;

const TODO_INSERT = `INSERT INTO todo_items
    (id, list_id, title, notes, due_date, assignee_member_id, completed_at, created_at, updated_at,
     repeat_every, repeat_unit, repeat_anchor_day)
  VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`;

/** `updated_at` must move forward even when two writes land in the same millisecond. */
const NEXT_UPDATED_AT = "MAX(?, updated_at + 1)";

function rowToTodoList(row: TodoListRow): TodoList {
  return {
    id: row.id,
    name: row.name,
    openCount: row.open_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRepeat(row: TodoRow): TodoRepeat | null {
  // The table's CHECK sets the three repeat columns together.
  return row.repeat_unit === null
    ? null
    : { every: row.repeat_every as number, unit: row.repeat_unit };
}

function rowToTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    listId: row.list_id,
    title: row.title,
    notes: row.notes,
    dueDate: row.due_date,
    assigneeMemberId: row.assignee_member_id,
    repeat: rowToRepeat(row),
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A request body as a plain record holding only `allowedKeys`. */
function allowListed<K extends string>(
  input: unknown,
  allowedKeys: readonly K[],
  subject: string
): Partial<Record<K, unknown>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TodoValidationError(`${subject} must be an object`);
  }
  const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.includes(key as K));
  if (unknownKeys.length > 0) {
    throw new TodoValidationError(`Unsupported field(s) in ${subject}: ${unknownKeys.join(", ")}`);
  }
  return input as Partial<Record<K, unknown>>;
}

/** A required label, stored trimmed; the cap applies to the trimmed value. A label that draws
 * nothing (only zero-width or format characters) is blank: it would leave an unnamed row.
 */
function parseLabel(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new TodoValidationError(`${field} must be a string`);
  const label = value.trim();
  if (!hasVisibleCharacter(label)) throw new TodoValidationError(`${field} must not be blank`);
  if (label.length > maxLength) {
    throw new TodoValidationError(`${field} exceeds ${maxLength} characters`);
  }
  return label;
}

function parseNotes(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new TodoValidationError("notes must be a string or null");
  if (value.length > TODO_NOTES_MAX_LENGTH) {
    throw new TodoValidationError(`notes exceeds ${TODO_NOTES_MAX_LENGTH} characters`);
  }
  return value.trim().length === 0 ? null : value;
}

function parseDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !isStrictCalendarDate(value)) {
    throw new TodoValidationError(`Invalid ${field}; expected strict YYYY-MM-DD`);
  }
  return value;
}

function parseDueDate(value: unknown): string | null {
  return value === undefined || value === null ? null : parseDate(value, "dueDate");
}

function parseListId(value: unknown): string {
  if (typeof value !== "string") throw new TodoValidationError("listId must be a string");
  if (!getDb().prepare("SELECT 1 FROM todo_lists WHERE id = ?").get(value)) {
    throw new TodoValidationError(`To-do list "${value}" does not exist`);
  }
  return value;
}

function isActiveParent(memberId: string): boolean {
  return listActiveMembers().some((member) => member.id === memberId && member.role === "parent");
}

/** Only adults take household to-dos (ADR-068): the assignee must be an active parent. */
function parseAssignee(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new TodoValidationError("assigneeMemberId must be a string or null");
  }
  if (!isActiveParent(value)) {
    throw new TodoValidationError(`Member "${value}" is not an active parent`);
  }
  return value;
}

function parseRepeat(value: unknown): TodoRepeat | null {
  if (value === undefined || value === null) return null;
  if (!isTodoRepeat(value)) {
    throw new TodoValidationError(
      `repeat must be null or { every: ${TODO_REPEAT_EVERY_MIN}..${TODO_REPEAT_EVERY_MAX}, unit: ${TODO_REPEAT_UNITS.join("|")} }`
    );
  }
  return { every: value.every, unit: value.unit };
}

/** The `repeat_*` column values in column order. A rule counts from the due date, so it cannot
 * stand without one. `keptAnchorDay` is the stored anchor of a rule and due date that did not
 * change; without it the rule anchors on the due date. */
function repeatColumns(
  repeat: TodoRepeat | null,
  dueDate: string | null,
  keptAnchorDay: number | null = null
): [number | null, TodoRepeatUnit | null, number | null] {
  if (repeat === null) return [null, null, null];
  if (dueDate === null) throw new TodoValidationError("A repeating to-do needs a due date");
  return [repeat.every, repeat.unit, keptAnchorDay ?? repeatAnchorDay(dueDate)];
}

function parseListName(input: unknown): string {
  const body = allowListed(input, TODO_LIST_WRITE_FIELDS, "to-do list body");
  return parseLabel(body.name, "name", TODO_LIST_NAME_MAX_LENGTH);
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "SQLITE_CONSTRAINT_UNIQUE";
}

/** The list as stored right after a successful write to it. */
function readList(id: string): TodoList {
  return rowToTodoList(getDb().prepare(`${LIST_SELECT} WHERE id = ?`).get(id) as TodoListRow);
}

function withUniqueName<T>(name: string, write: () => T): T {
  try {
    return write();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new TodoListNameConflictError(`A to-do list named "${name}" already exists`);
    }
    throw err;
  }
}

/** Every list ordered by name without regard to ASCII case, each with its count of open to-dos. */
export function listTodoLists(): TodoList[] {
  const rows = getDb()
    .prepare(`${LIST_SELECT} ORDER BY name COLLATE NOCASE ASC, name ASC`)
    .all() as TodoListRow[];
  return rows.map(rowToTodoList);
}

export function createTodoList(input: unknown): TodoList {
  const name = parseListName(input);
  const id = randomUUID();
  const now = Date.now();
  withUniqueName(name, () =>
    getDb()
      .prepare("INSERT INTO todo_lists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(id, name, now, now)
  );
  return readList(id);
}

export function renameTodoList(id: string, input: unknown): TodoList {
  const name = parseListName(input);
  const result = withUniqueName(name, () =>
    getDb()
      .prepare(`UPDATE todo_lists SET name = ?, updated_at = ${NEXT_UPDATED_AT} WHERE id = ?`)
      .run(name, Date.now(), id)
  );
  if (result.changes === 0) throw new TodoNotFoundError(`To-do list "${id}" does not exist`);
  return readList(id);
}

/** Deletes the list and, through the `todo_items.list_id` cascade, every to-do in it. */
export function deleteTodoList(id: string): void {
  const result = getDb().prepare("DELETE FROM todo_lists WHERE id = ?").run(id);
  if (result.changes === 0) throw new TodoNotFoundError(`To-do list "${id}" does not exist`);
}

/** Filters as they arrive in a query string: unvalidated, and an array when repeated. */
export type TodoFilters = Partial<
  Record<"listId" | "status" | "dueBy" | "assigneeMemberId", unknown>
>;

/** To-dos matching every given filter, `status` defaulting to `open`. Order: open before done,
 * then due date ascending with undated last, then creation order. `dueBy` keeps to-dos due on or
 * before that date, so it includes overdue ones and drops undated ones. `listId` and
 * `assigneeMemberId` match the stored ids as they are; an id nobody holds matches nothing.
 */
export function listTodos(query: TodoFilters = {}): Todo[] {
  const status = query.status ?? "open";
  if (!TODO_STATUS_FILTERS.includes(status as TodoStatusFilter)) {
    throw new TodoValidationError(`status must be one of ${TODO_STATUS_FILTERS.join(", ")}`);
  }

  const conditions: string[] = [];
  const params: string[] = [];
  if (status === "open") conditions.push("completed_at IS NULL");
  if (status === "done") conditions.push("completed_at IS NOT NULL");
  if (query.dueBy !== undefined) {
    conditions.push("due_date <= ?");
    params.push(parseDate(query.dueBy, "dueBy"));
  }
  for (const [key, column] of [
    ["listId", "list_id"],
    ["assigneeMemberId", "assignee_member_id"],
  ] as const) {
    const value = query[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new TodoValidationError(`${key} must be given once`);
    conditions.push(`${column} = ?`);
    params.push(value);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(
      `${TODO_SELECT} ${where}
       ORDER BY completed_at IS NOT NULL, due_date IS NULL, due_date ASC, created_at ASC, id ASC`
    )
    .all(...params) as TodoRow[];
  return rows.map(rowToTodo);
}

function readTodoRow(id: string): TodoRow {
  const row = getDb().prepare(`${TODO_SELECT} WHERE id = ?`).get(id) as TodoRow | undefined;
  if (!row) throw new TodoNotFoundError(`To-do "${id}" does not exist`);
  return row;
}

export function getTodo(id: string): Todo {
  return rowToTodo(readTodoRow(id));
}

export function createTodo(input: unknown): Todo {
  const body = allowListed(input, TODO_WRITE_FIELDS, "to-do body");
  const todo = {
    title: parseLabel(body.title, "title", TODO_TITLE_MAX_LENGTH),
    notes: parseNotes(body.notes),
    dueDate: parseDueDate(body.dueDate),
    listId: parseListId(body.listId),
    assigneeMemberId: parseAssignee(body.assigneeMemberId),
  };
  const repeat = repeatColumns(parseRepeat(body.repeat), todo.dueDate);
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(TODO_INSERT)
    .run(
      id,
      todo.listId,
      todo.title,
      todo.notes,
      todo.dueDate,
      todo.assigneeMemberId,
      now,
      now,
      ...repeat
    );
  return getTodo(id);
}

/** Partial edit: only the named fields change, and `null` clears a nullable one. The assignee is
 * checked only when the request changes it, so a to-do whose assignee was archived later stays
 * editable. Completion has its own commands and is never set here. A month or year rule keeps the
 * day of the month it was set on through shorter months; an edit that changes the due date or the
 * rule sets that day from the due date again.
 */
export function editTodo(id: string, input: unknown): Todo {
  const body = allowListed(input, TODO_WRITE_FIELDS, "to-do body");
  if (Object.keys(body).length === 0) {
    throw new TodoValidationError("To-do body must name at least one field");
  }
  const row = readTodoRow(id);
  const current = rowToTodo(row);
  const next = {
    title: "title" in body ? parseLabel(body.title, "title", TODO_TITLE_MAX_LENGTH) : current.title,
    notes: "notes" in body ? parseNotes(body.notes) : current.notes,
    dueDate: "dueDate" in body ? parseDueDate(body.dueDate) : current.dueDate,
    listId: "listId" in body ? parseListId(body.listId) : current.listId,
    assigneeMemberId:
      "assigneeMemberId" in body && body.assigneeMemberId !== current.assigneeMemberId
        ? parseAssignee(body.assigneeMemberId)
        : current.assigneeMemberId,
    repeat: "repeat" in body ? parseRepeat(body.repeat) : current.repeat,
  };
  const sameCycle = next.dueDate === current.dueDate && sameTodoRepeat(next.repeat, current.repeat);
  const repeat = repeatColumns(next.repeat, next.dueDate, sameCycle ? row.repeat_anchor_day : null);
  getDb()
    .prepare(
      `UPDATE todo_items
          SET list_id = ?, title = ?, notes = ?, due_date = ?, assignee_member_id = ?,
              repeat_every = ?, repeat_unit = ?, repeat_anchor_day = ?,
              updated_at = ${NEXT_UPDATED_AT}
        WHERE id = ?`
    )
    .run(
      next.listId,
      next.title,
      next.notes,
      next.dueDate,
      next.assigneeMemberId,
      ...repeat,
      Date.now(),
      id
    );
  return getTodo(id);
}

export function deleteTodo(id: string): void {
  const result = getDb().prepare("DELETE FROM todo_items WHERE id = ?").run(id);
  if (result.changes === 0) throw new TodoNotFoundError(`To-do "${id}" does not exist`);
}

/** Creates the occurrence that follows a repeating to-do just completed and records it on that
 * to-do, which therefore never creates a second one: not after a reopen, and not after the
 * occurrence is deleted. The copy carries list, title, notes and rule. It keeps the assignee only
 * while that member is still an active parent, because a completion must not fail over a member
 * who left. Null when the to-do has no rule, has created its occurrence before, or has no next
 * date.
 */
function createNextOccurrence(row: TodoRow, now: number): Todo | null {
  const repeat = rowToRepeat(row);
  if (repeat === null || row.next_todo_id !== null) return null;
  const anchorDay = row.repeat_anchor_day as number;
  const dueDate = nextRepeatDueDate(
    row.due_date as string,
    repeat,
    anchorDay,
    todayInHouseholdTz(now)
  );
  if (dueDate === null) return null;
  const assignee =
    row.assignee_member_id !== null && isActiveParent(row.assignee_member_id)
      ? row.assignee_member_id
      : null;
  const id = randomUUID();
  const db = getDb();
  db.prepare(TODO_INSERT).run(
    id,
    row.list_id,
    row.title,
    row.notes,
    dueDate,
    assignee,
    now,
    now,
    ...repeatColumns(repeat, dueDate, anchorDay)
  );
  db.prepare("UPDATE todo_items SET next_todo_id = ? WHERE id = ?").run(id, row.id);
  return getTodo(id);
}

/** Marks the to-do done. Idempotent: a to-do that is already done keeps its first `completedAt`.
 * The completion of a repeating to-do and the creation of its next occurrence commit together.
 */
export function completeTodo(id: string): TodoCompletion {
  const db = getDb();
  return db.transaction((): TodoCompletion => {
    const now = Date.now();
    const completedNow =
      db
        .prepare(
          `UPDATE todo_items SET completed_at = ?, updated_at = ${NEXT_UPDATED_AT}
            WHERE id = ? AND completed_at IS NULL`
        )
        .run(now, now, id).changes === 1;
    const row = readTodoRow(id);
    return {
      ...rowToTodo(row),
      nextOccurrence: completedNow ? createNextOccurrence(row, now) : null,
    };
  })();
}

/** Reopens the to-do. Idempotent: an open to-do is returned unchanged. */
export function reopenTodo(id: string): Todo {
  getDb()
    .prepare(
      `UPDATE todo_items SET completed_at = NULL, updated_at = ${NEXT_UPDATED_AT}
        WHERE id = ? AND completed_at IS NOT NULL`
    )
    .run(Date.now(), id);
  return getTodo(id);
}
