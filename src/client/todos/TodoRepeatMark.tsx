import { Repeat } from "lucide-react";

import { useTranslation } from "@/i18n";
import type { TodoRepeat } from "../../shared";
import { repeatLabel } from "./todo-presentation";

/** The mark of a repeating to-do: an icon whose accessible name says how often it repeats. */
export function TodoRepeatMark({ repeat }: { repeat: TodoRepeat }) {
  const { t } = useTranslation();
  const label = repeatLabel(repeat, t);
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex items-center">
      <Repeat aria-hidden="true" className="size-4" />
    </span>
  );
}
