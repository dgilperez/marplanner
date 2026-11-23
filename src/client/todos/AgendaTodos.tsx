import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { CheckboxField } from "@/components/CheckboxField";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { AgendaDetails, AgendaGroup, AgendaRow } from "@/home/AgendaGroup";
import { memberProfiles } from "@/home/agenda-presentation";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { apiFetch, readJson } from "@/lib/api";
import { appUrl } from "@/lib/base-path";
import type { Member, Todo } from "../../shared";
import { TodoDue } from "./TodoDue";
import { dueTodayThenOverdue, isOverdue, todoAssignees } from "./todo-presentation";
import { completionUrl, todosErrorKey, todosUrl } from "./todos-api";
import { usePendingIds } from "./usePendingIds";

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
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [writeError, setWriteError] = useState<MessageKey | null>(null);
  const [pendingIds, trackPending] = usePendingIds();
  // A slow read must not overwrite the answer of a later one.
  const generation = useRef(0);
  const profiles = useMemo(() => memberProfiles(members), [members]);

  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const due = await readJson<Todo[]>(todosUrl({ status: "open", dueBy: date }));
      if (current !== generation.current) return;
      setTodos(dueTodayThenOverdue(due, date));
      setReadFailed(false);
    } catch {
      if (current === generation.current) setReadFailed(true);
    }
  }, [date]);

  useEffect(() => {
    void load();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [load]);

  const occupied = todos === null || todos.length > 0 || readFailed;
  // Layout effects, so the agenda never paints "nothing today" next to a group about to appear.
  useLayoutEffect(() => onOccupiedChange(occupied), [occupied, onOccupiedChange]);
  useLayoutEffect(() => () => onOccupiedChange(false), [onOccupiedChange]);

  async function complete(todo: Todo) {
    setWriteError(null);
    try {
      await trackPending(todo.id, () => apiFetch(completionUrl(todo.id), { method: "POST" }));
      setTodos((current) => current?.filter((item) => item.id !== todo.id) ?? null);
      void load();
    } catch (error) {
      setWriteError(todosErrorKey(error, "todos.actionError"));
    }
  }

  const rows = todos ?? [];
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
      {(readFailed || writeError !== null) && (
        <li className="space-y-2">
          <ErrorNotice
            message={readFailed ? t("todos.agenda.error") : writeError && t(writeError)}
          />
          {readFailed && (
            <Button type="button" variant="outline" onClick={() => void load()}>
              {t("todos.agenda.retry")}
            </Button>
          )}
        </li>
      )}
      {rows.map((todo) => {
        const { activeAssignees, fallbackAssigneeLabels } = todoAssignees(todo, profiles);
        return (
          <AgendaRow key={todo.id} colorKeys={activeAssignees.map((member) => member.colorKey)}>
            <CheckboxField
              checked={false}
              disabled={pendingIds.has(todo.id)}
              onChange={() => void complete(todo)}
              label={todo.title}
              className="w-full font-bold wrap-anywhere"
            />
            {isOverdue(todo, date) && (
              <p className="pb-1 pl-[calc(var(--control-height)+0.5rem)] text-sm">
                <TodoDue todo={todo} today={date} />
              </p>
            )}
            <AgendaDetails
              details={[
                ...activeAssignees.map((member) => member.label),
                ...fallbackAssigneeLabels,
                ...(todo.assigneeMemberId === null ? [t("agenda.unassigned")] : []),
              ]}
            />
          </AgendaRow>
        );
      })}
    </AgendaGroup>
  );
}
