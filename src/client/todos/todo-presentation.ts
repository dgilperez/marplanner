import { resolveAssignees, type AgendaAssignees } from "@/home/agenda-presentation";
import type { Language } from "@/i18n/messages";
import { formatCalendarDate } from "@/lib/household-date";
import { Role, type Member, type Todo, type TodoList } from "../../shared";

/** An open to-do whose due date is before the household's today. */
export function isOverdue(todo: Pick<Todo, "dueDate" | "completedAt">, today: string): boolean {
  return todo.completedAt === null && todo.dueDate !== null && todo.dueDate < today;
}

/** A due date in the UI language. The year is written only when it is not today's year. */
export function formatDueDate(dueDate: string, today: string, language: Language): string {
  return formatCalendarDate(dueDate, language === "es" ? "es-ES" : "en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(dueDate.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  });
}

/** The members a to-do may be assigned to: active adults (TODOS-INV-05). */
export function assignableAdults(members: readonly Member[]): Member[] {
  return members.filter((member) => member.lifecycle === "active" && member.role === Role.parent);
}

/** Orders a "due on or before today" read for the Home agenda: today's to-dos, then the overdue
 * ones. The read order is kept inside each part. */
export function dueTodayThenOverdue(todos: readonly Todo[], today: string): Todo[] {
  return [
    ...todos.filter((todo) => !isOverdue(todo, today)),
    ...todos.filter((todo) => isOverdue(todo, today)),
  ];
}

/** Who a to-do belongs to, resolved like an event's assignees: at most one member. */
export function todoAssignees(
  todo: Pick<Todo, "assigneeMemberId">,
  profiles: ReadonlyMap<string, Member>
): AgendaAssignees {
  return resolveAssignees(todo.assigneeMemberId === null ? [] : [todo.assigneeMemberId], profiles);
}

/** Lists by name as the household reads them. The API orders by SQLite's NOCASE, which folds
 * ASCII letters only and so puts "Árbol" and "Ñu" after "zeta". */
export function listsInReadingOrder(lists: readonly TodoList[], language: Language): TodoList[] {
  const collator = new Intl.Collator(language, { sensitivity: "base" });
  return [...lists].sort((a, b) => collator.compare(a.name, b.name));
}

/** Fills the `{placeholder}`s of a message in one pass. A value is written as it is: `$&` in a
 * list name is not a replacement pattern, and a name holding `{count}` is not filled again. */
export function fillMessage(
  template: string,
  values: Readonly<Record<string, string | number>>
): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder
  );
}
