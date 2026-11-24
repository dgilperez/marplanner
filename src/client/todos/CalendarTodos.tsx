import { useMemo } from "react";
import { createPortal } from "react-dom";

import { memberProfiles } from "@/home/agenda-presentation";
import { useTranslation } from "@/i18n";
import type { Member, Todo } from "../../shared";
import { OpenTodoRow } from "./OpenTodoRow";
import { OpenTodosNotice } from "./OpenTodosNotice";
import { todosUrl } from "./todos-api";
import { useOpenTodos } from "./useOpenTodos";

export interface CalendarTodosProps {
  /** The days the calendar shows, in order. A new first or last day mounts a new read. */
  days: readonly string[];
  /** The calendar's element for each day it shows; a day's to-dos are drawn inside it. */
  daySlots: ReadonlyMap<string, HTMLElement>;
  /** The calendar's Members read. */
  members: readonly Member[];
  /** The calendar's member filter: whether it shows something assigned to these members. */
  showsAssignees(memberIds: readonly string[]): boolean;
}

/** The Calendar page contribution of the to-dos plugin: each visible day lists the open to-dos
 * due that day, each with a checkbox that completes it. One read covers the visible range. An
 * overdue to-do stays on its own due date; the Home agenda is where overdue ones are gathered. */
export function CalendarTodos({ days, daySlots, members, showsAssignees }: CalendarTodosProps) {
  const { t } = useTranslation();
  const { todos, readFailed, writeError, pendingIds, reload, complete } = useOpenTodos(
    todosUrl({ status: "open", dueFrom: days[0], dueBy: days[days.length - 1] })
  );
  const profiles = useMemo(() => memberProfiles(members), [members]);
  const byDay = useMemo(() => {
    const groups = new Map<string, Todo[]>();
    for (const todo of todos ?? []) {
      if (!showsAssignees(todo.assigneeMemberId === null ? [] : [todo.assigneeMemberId])) continue;
      // The range read returns dated to-dos only.
      const day = todo.dueDate as string;
      groups.set(day, [...(groups.get(day) ?? []), todo]);
    }
    return groups;
  }, [todos, showsAssignees]);

  return (
    <>
      <OpenTodosNotice
        as="div"
        className="flex flex-wrap items-center gap-2"
        readErrorKey="todos.calendar.error"
        readFailed={readFailed}
        writeError={writeError}
        reload={reload}
      />
      {days.map((day) => {
        const slot = daySlots.get(day);
        const due = byDay.get(day);
        if (!slot || !due) return null;
        return createPortal(
          <ul aria-label={t("todos.title")} className="m-0 flex list-none flex-col gap-1 p-0 pt-1">
            {due.map((todo) => (
              <OpenTodoRow
                key={todo.id}
                todo={todo}
                profiles={profiles}
                pending={pendingIds.has(todo.id)}
                onComplete={(item) => void complete(item)}
                className="px-0 py-0"
                labelClassName="gap-0 leading-tight font-medium"
              />
            ))}
          </ul>,
          slot,
          day
        );
      })}
    </>
  );
}
