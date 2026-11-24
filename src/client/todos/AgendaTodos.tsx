import { ChevronRight } from "lucide-react";
import { useLayoutEffect, useMemo } from "react";

import { AgendaGroup } from "@/home/AgendaGroup";
import { memberProfiles } from "@/home/agenda-presentation";
import { useTranslation } from "@/i18n";
import { appUrl } from "@/lib/base-path";
import type { Member } from "../../shared";
import { OpenTodoRow } from "./OpenTodoRow";
import { OpenTodosNotice } from "./OpenTodosNotice";
import { TodoDue } from "./TodoDue";
import { dueTodayThenOverdue, isOverdue } from "./todo-presentation";
import { todosUrl } from "./todos-api";
import { useOpenTodos } from "./useOpenTodos";

export interface AgendaTodosProps {
  /** The household date the agenda shows. A new date mounts a new read. */
  date: string;
  /** The agenda's Members read, archived members included. */
  members: readonly Member[];
  /** Tells the agenda whether this group takes room, so "nothing today" stays truthful. It is
   * also true while the first read is pending, and false again when the group unmounts. */
  onOccupiedChange(occupied: boolean): void;
}

/** The Home agenda group of the to-dos plugin: open to-dos due today, then the overdue ones.
 * It reads on mount, for each new household date, when the tablet becomes visible again and
 * after a completion. */
export function AgendaTodos({ date, members, onOccupiedChange }: AgendaTodosProps) {
  const { t } = useTranslation();
  const { todos, readFailed, writeError, pendingIds, reload, complete } = useOpenTodos(
    todosUrl({ status: "open", dueBy: date })
  );
  const profiles = useMemo(() => memberProfiles(members), [members]);
  const rows = useMemo(() => dueTodayThenOverdue(todos ?? [], date), [todos, date]);

  const occupied = todos === null || todos.length > 0 || readFailed;
  // Layout effects, so the agenda never paints "nothing today" next to a group about to appear.
  useLayoutEffect(() => onOccupiedChange(occupied), [occupied, onOccupiedChange]);
  useLayoutEffect(() => () => onOccupiedChange(false), [onOccupiedChange]);

  if (rows.length === 0 && !readFailed) return null;

  return (
    <AgendaGroup
      label={t("todos.title")}
      action={
        <a
          className="inline-flex shrink-0 items-center text-sm font-semibold underline-offset-4 hover:underline"
          href={appUrl("/todos")}
        >
          {t("todos.agenda.viewAll")}
          <ChevronRight aria-hidden="true" className="size-4" />
        </a>
      }
    >
      <OpenTodosNotice
        as="li"
        className="space-y-2"
        readErrorKey="todos.agenda.error"
        readFailed={readFailed}
        writeError={writeError}
        reload={reload}
      />
      {rows.map((todo) => (
        <OpenTodoRow
          key={todo.id}
          todo={todo}
          profiles={profiles}
          pending={pendingIds.has(todo.id)}
          onComplete={(item) => void complete(item)}
          labelClassName="font-bold"
        >
          {isOverdue(todo, date) && (
            <p className="pb-1 pl-[calc(var(--control-height)+0.5rem)] text-sm">
              <TodoDue todo={todo} today={date} />
            </p>
          )}
        </OpenTodoRow>
      ))}
    </AgendaGroup>
  );
}
