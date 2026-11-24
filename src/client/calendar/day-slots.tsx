import { useCallback, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Gives the element a calendar view renders for one day to whoever fills it. */
export type DaySlotRef = (date: string) => (element: HTMLElement | null) => void;

/** The per-day slots of the Calendar page: an empty element in each visible day that a plugin
 * contribution draws into, so the views know nothing of what a plugin adds to a day. Returns the
 * mounted slots by date and the ref a view puts on each day's slot. */
export function useDaySlots(): [slots: ReadonlyMap<string, HTMLElement>, slotRef: DaySlotRef] {
  const [slots, setSlots] = useState<ReadonlyMap<string, HTMLElement>>(new Map());
  // One stable callback per date: React calls a ref again whenever its identity changes.
  const refs = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const slotRef = useCallback<DaySlotRef>((date) => {
    let ref = refs.current.get(date);
    if (!ref) {
      ref = (element) =>
        setSlots((current) => {
          const next = new Map(current);
          if (element) next.set(date, element);
          else next.delete(date);
          return next;
        });
      refs.current.set(date, ref);
    }
    return ref;
  }, []);
  return [slots, slotRef];
}

/** The week view with its day slots: one column per day under the time grid (`children`), which
 * has no room of its own for them. The frame keeps the height the week view always had. While a
 * contribution fills the slots (`reserved`) the strip has a fixed height, taken from the bottom of
 * the grid, and scrolls a day with many entries. The height does not follow the content: the grid
 * centres the current hour once, when it opens, and a strip that grew when its entries arrived
 * would cover the hours under that centre.
 */
export function WeekDaySlots({
  days,
  slotRef,
  reserved,
  children,
}: {
  days: readonly string[];
  slotRef: DaySlotRef;
  reserved: boolean;
  children: ReactNode;
}) {
  return (
    <div data-testid="calendar-week-frame" className="sx-week-frame">
      {children}
      <div
        data-testid="calendar-week-day-slots"
        className={cn(
          "grid shrink-0 grid-cols-7 gap-px overflow-y-auto pl-[var(--sx-calendar-week-grid-padding-left,75px)]",
          reserved && "h-24"
        )}
      >
        {days.map((date) => (
          <div key={date} data-calendar-day-slot={date} ref={slotRef(date)} className="min-w-0" />
        ))}
      </div>
    </div>
  );
}
