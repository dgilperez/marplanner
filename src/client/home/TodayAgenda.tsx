import { appUrl } from "@/lib/base-path";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { readJson } from "@/lib/api";
import { formatCalendarDate, wakeAfter } from "@/lib/household-date";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { cn } from "@/lib/utils";
import { PluginContribution, usePluginCatalogPending } from "@/plugins/contributions";
import { AgendaTodos } from "@/todos/AgendaTodos";
import type { FeedItem, Member } from "../../shared";
import { nextOccurrenceInTz } from "../../shared/householdTime";
import { AgendaDetails, AgendaGroup, AgendaRow } from "./AgendaGroup";
import {
  householdDayRange,
  presentAgenda,
  type AgendaPresentationItem,
} from "./agenda-presentation";

const temporalLabels: Record<AgendaPresentationItem["temporalState"], MessageKey> = {
  past: "agenda.past",
  "in-progress": "agenda.inProgress",
  next: "agenda.next",
  future: "agenda.future",
};
type AgendaState =
  | { status: "loading" | "failed" }
  | { status: "ready"; events: FeedItem[]; members: Member[]; timezone: string; date: string };

export function TodayAgenda(): React.JSX.Element {
  const { t, language } = useTranslation();
  const {
    timezone: configuredTimezone,
    status: settingsStatus,
    retry: retrySettings,
  } = useHouseholdSettings();
  const [state, setState] = useState<AgendaState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  // The to-dos contribution reports whether it shows anything; an inactive plugin never mounts
  // it, so the agenda stays empty-aware without knowing the plugin's data.
  const [todosOccupied, setTodosOccupied] = useState(false);
  // Until the plugin catalog answers, the to-dos group may still mount and take room.
  const catalogPending = usePluginCatalogPending();

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    if (settingsStatus === "loading") return () => controller.abort();
    if (settingsStatus === "error" || !configuredTimezone) {
      setState({ status: "failed" });
      return () => controller.abort();
    }
    void (async () => {
      const timezone = configuredTimezone;
      const instant = Date.now();
      const range = householdDayRange(timezone, instant);
      const query = new URLSearchParams({ source: "all", from: range.from, to: range.to });
      const [events, members] = await Promise.all([
        readJson<FeedItem[]>(`/api/calendar/events?${query}`, { signal: controller.signal }),
        readJson<Member[]>("/api/members?lifecycle=all", { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      setNow(Date.now());
      setState({ status: "ready", events, members, timezone, date: range.date });
    })().catch(() => {
      if (!controller.signal.aborted) setState({ status: "failed" });
    });
    return () => controller.abort();
  }, [configuredTimezone, settingsStatus, attempt]);

  useEffect(() => {
    if (state.status !== "ready") return;
    // Re-project exactly at event edges; refetch only on household-day rollover.
    // Visibility recovery handles a tablet waking after a throttled timer. No polling.
    const refresh = () => {
      const instant = Date.now();
      if (householdDayRange(state.timezone, instant).date !== state.date) {
        setState({ status: "loading" });
        setAttempt((value) => value + 1);
      }
      setNow(instant);
    };
    const edges = state.events
      .filter((event) => !event.allDay)
      .flatMap((event) => [
        Date.parse(event.occurrenceStart),
        Date.parse(event.occurrenceEnd ?? ""),
      ])
      .filter((edge) => edge > now);
    const next = Math.min(nextOccurrenceInTz("00:00", state.timezone, now), ...edges);
    const delay = next - Date.now();
    if (delay <= 0 || householdDayRange(state.timezone, now).date !== state.date) {
      refresh();
      return;
    }
    return wakeAfter(delay, refresh);
  }, [state, now]);

  const items =
    state.status === "ready"
      ? presentAgenda(state.events, state.members, state.timezone, now, language)
      : [];
  const time =
    state.status === "ready"
      ? new Intl.DateTimeFormat(language === "es" ? "es-ES" : "en-GB", {
          timeZone: state.timezone,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })
      : null;
  const date =
    state.status === "ready"
      ? formatCalendarDate(state.date, language === "es" ? "es-ES" : "en-US", {
          weekday: "long",
          month: "short",
          day: "numeric",
        })
      : null;

  const occupied = items.length > 0 || todosOccupied || catalogPending;
  const allDayItems = items.filter((item) => item.kind === "all-day");
  const timedItems = items.filter((item) => item.kind === "timed");

  const renderItem = (item: AgendaPresentationItem) => (
    <AgendaRow
      key={`${item.event.id}@${item.event.occurrenceStart}`}
      colorKeys={item.activeAssignees.map((member) => member.colorKey)}
      allDay={item.kind === "all-day"}
      className={cn(
        item.temporalState === "past" && "text-muted-foreground",
        (item.temporalState === "in-progress" || item.temporalState === "next") &&
          "font-semibold ring-1 ring-foreground"
      )}
    >
      <div className="flex min-w-0 gap-3">
        {item.kind === "timed" && (
          <div
            data-testid="agenda-time"
            className="flex shrink-0 flex-col items-center pt-0.5 font-mono text-xs leading-tight font-semibold tabular-nums"
          >
            <time dateTime={item.event.occurrenceStart}>
              {time!.format(new Date(item.event.occurrenceStart))}
            </time>
            {item.event.occurrenceEnd && (
              <time dateTime={item.event.occurrenceEnd} className="text-muted-foreground">
                {time!.format(new Date(item.event.occurrenceEnd))}
              </time>
            )}
          </div>
        )}
        <h4 className="min-w-0 font-bold break-words">
          {item.event.decoratedTitle ?? item.event.title}
        </h4>
      </div>
      <AgendaDetails
        details={[
          ...(item.kind === "timed" ? [t(temporalLabels[item.temporalState])] : []),
          ...item.activeAssignees.map((member) => member.label),
          ...item.fallbackAssigneeLabels,
          ...(item.event.assignedTo.length === 0 ? [t("agenda.unassigned")] : []),
        ]}
      />
    </AgendaRow>
  );

  return (
    <section
      aria-label={t("agenda.title")}
      className="bg-card flex h-full min-h-0 flex-col rounded-3xl border p-5 text-control shadow-sm"
    >
      <header className="flex shrink-0 items-center justify-between gap-4 border-b pb-4">
        {date && (
          <h2 className="font-display min-w-0 text-xl leading-tight font-bold capitalize">
            {date}
          </h2>
        )}
        <a
          className="ml-auto inline-flex shrink-0 items-center text-sm font-semibold underline-offset-4 hover:underline"
          href={appUrl("/calendar")}
        >
          {t("agenda.viewAll")}
          <ChevronRight aria-hidden="true" className="size-4" />
        </a>
      </header>
      {state.status === "loading" && (
        <p role="status" className="py-4 text-muted-foreground">
          {t("agenda.loading")}
        </p>
      )}
      {state.status === "failed" && (
        <div className="space-y-2 py-4">
          <ErrorNotice message={t("agenda.error")} />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (settingsStatus === "error" || !configuredTimezone) retrySettings();
              else setAttempt((value) => value + 1);
            }}
          >
            {t("agenda.retry")}
          </Button>
        </div>
      )}
      {state.status === "ready" && !occupied && (
        <p className="py-4 text-muted-foreground">{t("agenda.empty")}</p>
      )}
      {state.status === "ready" && (
        // Kept mounted while the day is empty: the to-dos group inside it reports whether it has
        // rows, and remounting it on every answer would read the to-dos again.
        <div
          data-testid="agenda-groups"
          hidden={!occupied}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto pt-4 pr-1"
        >
          {allDayItems.length > 0 && (
            <AgendaGroup label={t("agenda.allDay")}>{allDayItems.map(renderItem)}</AgendaGroup>
          )}
          {timedItems.length > 0 && (
            <AgendaGroup label={t("agenda.scheduled")}>{timedItems.map(renderItem)}</AgendaGroup>
          )}
          <PluginContribution pluginId="todos" group="widgets" contributionId="agenda-todos">
            <AgendaTodos
              date={state.date}
              members={state.members}
              onOccupiedChange={setTodosOccupied}
            />
          </PluginContribution>
        </div>
      )}
    </section>
  );
}
