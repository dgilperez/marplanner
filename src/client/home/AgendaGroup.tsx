import { Fragment, useId, type ReactNode } from "react";
import { memberEventStyle } from "@/calendar/member-event-style";
import { cn } from "@/lib/utils";
import type { MemberColorKey } from "../../shared";

// Literal generated-token utilities keep every identity colour visible to Tailwind.
const accentTokens: Record<MemberColorKey, string> = {
  blue: "border-l-member-blue-500",
  sky: "border-l-member-sky-500",
  teal: "border-l-member-teal-500",
  green: "border-l-member-green-500",
  lime: "border-l-member-lime-500",
  amber: "border-l-member-amber-500",
  orange: "border-l-member-orange-500",
  red: "border-l-member-red-500",
  pink: "border-l-member-pink-500",
  violet: "border-l-member-violet-500",
};

/** One labelled agenda group: a small caption, a dotted rule, an optional action and its list. */
export function AgendaGroup({
  label,
  action,
  children,
}: {
  label: string;
  /** Shown after the rule, e.g. a link to the page that owns the group's rows. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3
          id={labelId}
          className="text-muted-foreground text-xs font-bold tracking-widest whitespace-nowrap uppercase"
        >
          {label}
        </h3>
        <div aria-hidden="true" className="flex-1 border-b border-dotted" />
        {action}
      </div>
      <ul aria-labelledby={labelId} className="m-0 list-none space-y-2">
        {children}
      </ul>
    </section>
  );
}

/** One agenda row on the surface of the members it belongs to. */
export function AgendaRow({
  colorKeys,
  allDay = false,
  className,
  children,
}: {
  /** Identity colours of the row's active assignees, in assignment order. */
  colorKeys: readonly MemberColorKey[];
  /** An all-day row nobody owns takes the all-day surface instead of the plain one. */
  allDay?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const accent = colorKeys[0];
  return (
    <li
      className={cn(
        // `relative` keeps the visually hidden details inside the row, so rows scrolled out
        // of the list do not extend the page.
        "relative rounded-md border-l-4 px-3 py-2",
        // Member identity wins; only an all-day row nobody owns takes the all-day surface.
        allDay && !accent
          ? "bg-event-all-day border-l-event-all-day-border"
          : "member-event-surface",
        accent ? accentTokens[accent] : !allDay && "border-l-transparent",
        className
      )}
      // eslint-disable-next-line ui-policy/debt -- Assigned-member identity is passed through CSS custom properties into the token-based event surface.
      style={memberEventStyle(colorKeys)}
    >
      {children}
    </li>
  );
}

/** Status and assignment are not drawn; they stay in the row for assistive technology. */
export function AgendaDetails({ details }: { details: readonly string[] }) {
  return (
    <p className="sr-only" data-testid="agenda-details">
      {details.map((detail, index) => (
        <Fragment key={index}>
          {index > 0 && ", "}
          <span>{detail}</span>
        </Fragment>
      ))}
    </p>
  );
}
