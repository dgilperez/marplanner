import type { ReactNode } from "react";

import { CheckboxField } from "@/components/CheckboxField";
import { AgendaDetails, AgendaRow } from "@/home/AgendaGroup";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import type { Member, Todo } from "../../shared";
import { todoAssignees } from "./todo-presentation";

interface OpenTodoRowProps {
  todo: Todo;
  profiles: ReadonlyMap<string, Member>;
  /** True while the completion of this to-do is on its way; the checkbox is disabled. */
  pending: boolean;
  onComplete(todo: Todo): void;
  className?: string;
  labelClassName?: string;
  /** Drawn between the checkbox and the details kept for assistive technology. */
  children?: ReactNode;
}

/** An open to-do outside the To-dos page: a checkbox that completes it, on the surface of its
 * assignee like an event row, with the assignee named for assistive technology. */
export function OpenTodoRow({
  todo,
  profiles,
  pending,
  onComplete,
  className,
  labelClassName,
  children,
}: OpenTodoRowProps) {
  const { t } = useTranslation();
  const { activeAssignees, fallbackAssigneeLabels } = todoAssignees(todo, profiles);
  return (
    <AgendaRow colorKeys={activeAssignees.map((member) => member.colorKey)} className={className}>
      <CheckboxField
        checked={false}
        disabled={pending}
        onChange={() => onComplete(todo)}
        label={todo.title}
        className={cn("w-full wrap-anywhere", labelClassName)}
      />
      {children}
      <AgendaDetails
        details={[
          ...activeAssignees.map((member) => member.label),
          ...fallbackAssigneeLabels,
          ...(todo.assigneeMemberId === null ? [t("agenda.unassigned")] : []),
        ]}
      />
    </AgendaRow>
  );
}
