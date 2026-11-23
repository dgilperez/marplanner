import { CircleAlert } from "lucide-react";

import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import type { Todo } from "../../shared";
import { formatDueDate, isOverdue } from "./todo-presentation";

/** A to-do's due date. An overdue one is marked with text, so assistive technology reads it and
 * colour is never the only signal. Renders nothing for an undated to-do. */
export function TodoDue({ todo, today }: { todo: Todo; today: string | null }) {
  const { t, language } = useTranslation();
  if (todo.dueDate === null) return null;
  const overdue = today !== null && isOverdue(todo, today);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {overdue && (
        <span className="border-destructive/40 bg-destructive/10 text-foreground inline-flex items-center gap-1 rounded-full border px-2 font-semibold">
          <CircleAlert aria-hidden="true" className="size-4" />
          {t("todos.item.overdue")}
        </span>
      )}
      <time dateTime={todo.dueDate} className={cn(overdue && "text-foreground font-semibold")}>
        {formatDueDate(todo.dueDate, today ?? todo.dueDate, language)}
      </time>
    </span>
  );
}
