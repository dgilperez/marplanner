import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedItem } from "../../src/shared";
import { json } from "./helpers/fetchRoutes";
import { NOW, todosBackend, type TodosBackendOptions } from "./helpers/todosBackend";

vi.mock("@/lib/adminUnlock", () => ({
  useAdminUnlock: () => ({ unlocked: true, setUnlocked: vi.fn() }),
}));

// Schedule-X needs a layout engine; the strip that holds the week's to-dos is the Calendar's own.
vi.mock("@/calendar/ScheduleXWeekView", () => ({
  ScheduleXWeekView: ({ events }: { events: readonly FeedItem[] }) => (
    <div data-testid="calendar-week-grid">
      {events.map((event) => (
        <span key={event.id} data-testid="calendar-event-row">
          {event.title}
        </span>
      ))}
    </div>
  ),
}));

import { CalendarView } from "@/calendar/CalendarView";
import { LanguageProvider } from "@/i18n";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { PluginCatalogProvider } from "@/plugins/PluginCatalogProvider";

const lists = [{ id: "home", name: "Casa" }];
const todos: TodosBackendOptions["todos"] = [
  { id: "undated", listId: "home", title: "Fix the tap" },
  { id: "overdue", listId: "home", title: "Renew passport", dueDate: "2026-09-18" },
  {
    id: "today",
    listId: "home",
    title: "Call the plumber",
    dueDate: "2026-09-22",
    assigneeMemberId: "blair",
  },
  {
    id: "today-dana",
    listId: "home",
    title: "Pagar el seguro",
    dueDate: "2026-09-22",
    assigneeMemberId: "dana",
  },
  { id: "saturday", listId: "home", title: "Book the van", dueDate: "2026-09-26" },
  { id: "october", listId: "home", title: "Renew the car insurance", dueDate: "2026-10-03" },
  { id: "later", listId: "home", title: "Service the boiler", dueDate: "2026-10-20" },
  {
    id: "finished",
    listId: "home",
    title: "Pay the deposit",
    dueDate: "2026-09-22",
    completedAt: 5,
  },
];
const meeting: FeedItem = {
  id: "meeting",
  title: "School meeting",
  occurrenceStart: "2026-09-22T15:00:00Z",
  occurrenceEnd: "2026-09-22T16:00:00Z",
  allDay: false,
  source: "local",
  assignedTo: [],
};

function mount(options: TodosBackendOptions & { withCatalog?: boolean } = {}) {
  const { withCatalog = false, ...backendOptions } = options;
  const backend = todosBackend({
    lists,
    todos,
    other: (key) => (key.startsWith("GET /api/calendar/events?") ? json([meeting]) : undefined),
    ...backendOptions,
  });
  const calendar = (
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <CalendarView />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
  render(withCatalog ? <PluginCatalogProvider>{calendar}</PluginCatalogProvider> : calendar);
  return backend;
}

/** The month cell of a day, or its column of the week strip. */
const day = (date: string) =>
  document.querySelector<HTMLElement>(`[data-date="${date}"], [data-calendar-day-slot="${date}"]`)!;
/** The to-do titles a day shows, in order. */
const titlesOn = (date: string) =>
  within(day(date))
    .queryAllByRole("checkbox")
    .map((checkbox) => checkbox.closest("label")?.textContent);
const todoReads = (backend: ReturnType<typeof mount>) => backend.keys("GET /api/todos?");
const monthGrid = () => screen.findByTestId("calendar-month-grid");
async function showWeek() {
  fireEvent.click(screen.getByRole("button", { name: "Week" }));
  await screen.findByTestId("calendar-week-day-slots");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Calendar to-dos — month", () => {
  it("shows each open to-do on the day it is due, and none that is undated or done", async () => {
    mount();
    await monthGrid();
    await waitFor(() =>
      expect(titlesOn("2026-09-22")).toEqual(["Call the plumber", "Pagar el seguro"])
    );
    expect(titlesOn("2026-09-26")).toEqual(["Book the van"]);
    expect(titlesOn("2026-10-03")).toEqual(["Renew the car insurance"]);
    expect(screen.queryByRole("checkbox", { name: "Fix the tap" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Pay the deposit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Service the boiler" })).not.toBeInTheDocument();
    for (const checkbox of document.querySelectorAll("[data-calendar-day-slot] [type=checkbox]")) {
      expect(checkbox).not.toBeChecked();
    }
  });

  it("keeps an overdue to-do on its own due date and not on today", async () => {
    mount();
    await monthGrid();
    await waitFor(() => expect(titlesOn("2026-09-18")).toEqual(["Renew passport"]));
    expect(titlesOn("2026-09-22")).not.toContain("Renew passport");
    expect(titlesOn("2026-09-19")).toEqual([]);
    expect(day("2026-09-22")).toHaveAttribute("data-today", "true");
  });

  it("draws a to-do as a checkbox row beside the day's event chips, not as a chip", async () => {
    mount();
    await monthGrid();
    const today = day("2026-09-22");
    const row = (await within(today).findByRole("checkbox", { name: "Call the plumber" })).closest(
      "li"
    )!;
    expect(row).not.toHaveAttribute("data-testid", "calendar-event-row");
    expect(within(today).getByRole("list", { name: "To-dos" })).toContainElement(row);
    const chips = within(today).getAllByTestId("calendar-event-row");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      expect.stringContaining("School meeting"),
    ]);
    expect(chips[0]).not.toContainElement(row);
  });

  it("gives a to-do the identity colour of its assignee and names the assignee", async () => {
    mount();
    await monthGrid();
    const assigned = (await screen.findByRole("checkbox", { name: "Call the plumber" })).closest(
      "li"
    )!;
    expect(assigned.style.getPropertyValue("--member-event-border")).toBe(
      "var(--color-member-pink-500)"
    );
    expect(within(assigned).getByTestId("agenda-details")).toHaveTextContent("Blair");
    const unassigned = screen.getByRole("checkbox", { name: "Book the van" }).closest("li")!;
    expect(unassigned.style.getPropertyValue("--member-event-border")).toBe("");
    expect(within(unassigned).getByTestId("agenda-details")).toHaveTextContent("Unassigned");
  });

  it("reads the visible range once, and again only when the range changes", async () => {
    const backend = mount();
    await monthGrid();
    await screen.findByRole("checkbox", { name: "Call the plumber" });
    expect(todoReads(backend)).toEqual([
      "GET /api/todos?status=open&dueFrom=2026-08-31&dueBy=2026-10-04",
    ]);

    // A filter redraws the calendar without a new range.
    fireEvent.click(screen.getByRole("checkbox", { name: "All-day events" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "All-day events" }));
    expect(todoReads(backend)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Next period" }));
    expect(await screen.findByRole("checkbox", { name: "Service the boiler" })).toBeVisible();
    expect(todoReads(backend)).toEqual([
      "GET /api/todos?status=open&dueFrom=2026-08-31&dueBy=2026-10-04",
      "GET /api/todos?status=open&dueFrom=2026-09-28&dueBy=2026-11-01",
    ]);
    expect(titlesOn("2026-10-20")).toEqual(["Service the boiler"]);
    expect(titlesOn("2026-10-03")).toEqual(["Renew the car insurance"]);
  });

  it("completes a to-do from its checkbox, takes it off the day and reads again", async () => {
    const backend = mount();
    await monthGrid();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Call the plumber" }));
    await waitFor(() => expect(titlesOn("2026-09-22")).toEqual(["Pagar el seguro"]));
    expect(backend.keys("POST")).toEqual(["POST /api/todos/today/completion"]);
    expect(backend.todo("today")?.completedAt).toBe(NOW);
    await waitFor(() => expect(todoReads(backend)).toHaveLength(2));
    // Completing opens nothing: the event dialog stays closed.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the next occurrence of a completed repeating to-do when it falls in the visible range", async () => {
    mount({
      todos: [
        {
          id: "filter",
          listId: "home",
          title: "Change the filter",
          dueDate: "2026-09-22",
          repeat: { every: 1, unit: "week" },
        },
      ],
    });
    await monthGrid();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Change the filter" }));
    await waitFor(() => expect(titlesOn("2026-09-29")).toEqual(["Change the filter"]));
    expect(titlesOn("2026-09-22")).toEqual([]);
  });

  it("reports a completion that failed and keeps the to-do on its day", async () => {
    mount({
      intercept: (key) =>
        key === "POST /api/todos/today/completion"
          ? json({ error: "internal_error" }, 500)
          : undefined,
    });
    await monthGrid();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Call the plumber" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The change could not be saved.");
    expect(titlesOn("2026-09-22")).toEqual(["Call the plumber", "Pagar el seguro"]);
    expect(screen.getByRole("checkbox", { name: "Call the plumber" })).toBeEnabled();
  });

  it("disables a checkbox while its completion is on its way, and only that one", async () => {
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    const backend = mount({
      intercept: async (key) => {
        if (key === "POST /api/todos/today/completion") await pending;
        return undefined;
      },
    });
    await monthGrid();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Call the plumber" }));
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Call the plumber" })).toBeDisabled()
    );
    expect(screen.getByRole("checkbox", { name: "Pagar el seguro" })).toBeEnabled();
    await act(async () => release());
    await waitFor(() => expect(titlesOn("2026-09-22")).toEqual(["Pagar el seguro"]));
    expect(backend.keys("POST")).toEqual(["POST /api/todos/today/completion"]);
  });

  it("lists every to-do of a busy day inside that day, as the month view does with events", async () => {
    const busy = Array.from({ length: 12 }, (_, index) => ({
      id: `busy-${index}`,
      listId: "home",
      title: `To-do ${index + 1}`,
      dueDate: "2026-09-23",
    }));
    mount({ todos: busy });
    await monthGrid();
    await waitFor(() => expect(titlesOn("2026-09-23")).toHaveLength(12));
    // The cell clips what is wider than its column and grows downwards with its week row.
    expect(day("2026-09-23")).toHaveClass("overflow-hidden");
    expect(day("2026-09-23").className).not.toMatch(/(^|\s)(h|max-h)-/);
    for (const checkbox of within(day("2026-09-23")).getAllByRole("checkbox")) {
      expect(checkbox.closest("label")).toHaveClass("wrap-anywhere");
    }
    expect(titlesOn("2026-09-24")).toEqual([]);
  });

  it("follows the member filter: an unassigned to-do stays, another member's goes", async () => {
    mount();
    await monthGrid();
    await screen.findByRole("checkbox", { name: "Call the plumber" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Dana" }));
    await waitFor(() => expect(titlesOn("2026-09-22")).toEqual(["Pagar el seguro"]));
    expect(titlesOn("2026-09-26")).toEqual(["Book the van"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Dana" }));
    await waitFor(() =>
      expect(titlesOn("2026-09-22")).toEqual(["Call the plumber", "Pagar el seguro"])
    );
  });

  it("reports a failed read with its own retry and keeps the events", async () => {
    let fail = true;
    const backend = mount({
      intercept: (key) =>
        key.startsWith("GET /api/todos?") && fail
          ? json({ error: "internal_error", message: "private detail" }, 500)
          : undefined,
    });
    await monthGrid();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The to-dos of these days could not be loaded."
    );
    expect(screen.queryByText("private detail")).not.toBeInTheDocument();
    expect(screen.getByTestId("calendar-event-row")).toHaveTextContent("School meeting");

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry to-dos" }));
    expect(await screen.findByRole("checkbox", { name: "Call the plumber" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(todoReads(backend)).toHaveLength(2);
  });

  it("reads again when the tablet becomes visible", async () => {
    const backend = mount();
    await monthGrid();
    await screen.findByRole("checkbox", { name: "Call the plumber" });
    backend.todos.set("new", {
      ...backend.todo("today")!,
      id: "new",
      title: "Sort mail",
      dueDate: "2026-09-24",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(titlesOn("2026-09-24")).toEqual(["Sort mail"]));
  });

  it("labels each day's list Pendientes in Spanish", async () => {
    mount({ language: "es" });
    await monthGrid();
    await screen.findByRole("checkbox", { name: "Call the plumber" });
    expect(within(day("2026-09-22")).getByRole("list", { name: "Pendientes" })).toBeVisible();
  });
});

describe("Calendar to-dos — week", () => {
  it("shows each open to-do in the column of its day, for the visible week only", async () => {
    const backend = mount();
    await monthGrid();
    await showWeek();
    await waitFor(() =>
      expect(titlesOn("2026-09-22")).toEqual(["Call the plumber", "Pagar el seguro"])
    );
    expect(titlesOn("2026-09-26")).toEqual(["Book the van"]);
    expect(titlesOn("2026-09-21")).toEqual([]);
    expect(
      [...document.querySelectorAll("[data-calendar-day-slot]")].map((slot) =>
        slot.getAttribute("data-calendar-day-slot")
      )
    ).toEqual([
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
    ]);
    // The overdue one is before this week, the undated and the done one are never shown.
    expect(screen.queryByRole("checkbox", { name: "Renew passport" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Fix the tap" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Pay the deposit" })).not.toBeInTheDocument();
    expect(todoReads(backend).at(-1)).toBe(
      "GET /api/todos?status=open&dueFrom=2026-09-21&dueBy=2026-09-27"
    );
    expect(todoReads(backend)).toHaveLength(2);
  });

  it("keeps an overdue to-do on its own day when the week is shown", async () => {
    mount();
    await monthGrid();
    await showWeek();
    fireEvent.click(screen.getByRole("button", { name: "Previous period" }));
    await waitFor(() => expect(titlesOn("2026-09-18")).toEqual(["Renew passport"]));
    expect(screen.queryByRole("checkbox", { name: "Call the plumber" })).not.toBeInTheDocument();
  });

  it("completes a to-do from the week and shows the next occurrence a week later", async () => {
    const backend = mount({
      todos: [
        {
          id: "filter",
          listId: "home",
          title: "Change the filter",
          dueDate: "2026-09-22",
          repeat: { every: 1, unit: "week" },
        },
      ],
    });
    await monthGrid();
    await showWeek();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Change the filter" }));
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Change the filter" })).not.toBeInTheDocument()
    );
    expect(backend.keys("POST")).toEqual(["POST /api/todos/filter/completion"]);

    fireEvent.click(screen.getByRole("button", { name: "Next period" }));
    await waitFor(() => expect(titlesOn("2026-09-29")).toEqual(["Change the filter"]));
  });

  it("scrolls a busy day inside the strip so the time grid keeps its place", async () => {
    const busy = Array.from({ length: 12 }, (_, index) => ({
      id: `busy-${index}`,
      listId: "home",
      title: `To-do ${index + 1}`,
      dueDate: "2026-09-23",
    }));
    mount({ todos: busy });
    await monthGrid();
    await showWeek();
    await waitFor(() => expect(titlesOn("2026-09-23")).toHaveLength(12));
    const strip = screen.getByTestId("calendar-week-day-slots");
    expect(strip).toHaveClass("h-24", "overflow-y-auto", "grid-cols-7");
    // The strip comes after the grid, as a day's to-dos come after its events in the month.
    expect(strip.compareDocumentPosition(screen.getByTestId("calendar-week-grid"))).toBe(
      Node.DOCUMENT_POSITION_PRECEDING
    );
    // Strip and grid share the frame that has the week view's fixed height, so the strip takes
    // its room from the grid and not from the page.
    const frame = screen.getByTestId("calendar-week-frame");
    expect(frame).toHaveClass("sx-week-frame");
    expect(strip.parentElement).toBe(frame);
    expect(frame).toContainElement(screen.getByTestId("calendar-week-grid"));
    expect(strip).toHaveClass("shrink-0");
  });

  it("keeps the strip's room in a week without to-dos, so arriving to-dos resize nothing", async () => {
    mount({ todos: [] });
    await monthGrid();
    await showWeek();
    expect(screen.getByTestId("calendar-week-day-slots")).toHaveClass("h-24", "shrink-0");
    expect(document.querySelector("[data-calendar-day-slot] [type=checkbox]")).toBeNull();
  });
});

describe("Calendar to-dos — household day and plugin state", () => {
  it("takes the visible days from the household timezone, not from the tablet's", async () => {
    // 16:00 UTC on 30 September is already 1 October in Tokyo.
    vi.setSystemTime("2026-09-30T16:00:00Z");
    const backend = mount({
      timezone: "Asia/Tokyo",
      todos: [
        { id: "first", listId: "home", title: "Pagar el seguro", dueDate: "2026-10-01" },
        { id: "last", listId: "home", title: "Call the plumber", dueDate: "2026-09-30" },
      ],
    });
    await monthGrid();
    await waitFor(() => expect(titlesOn("2026-10-01")).toEqual(["Pagar el seguro"]));
    expect(day("2026-10-01")).toHaveAttribute("data-today", "true");
    expect(titlesOn("2026-09-30")).toEqual(["Call the plumber"]);
    expect(day("2026-09-30")).not.toHaveAttribute("data-today");
    expect(todoReads(backend).at(-1)).toBe(
      "GET /api/todos?status=open&dueFrom=2026-09-28&dueBy=2026-11-01"
    );
  });

  it("shows the to-dos while the plugin is active", async () => {
    mount({ withCatalog: true });
    await monthGrid();
    expect(await screen.findByRole("checkbox", { name: "Call the plumber" })).toBeVisible();
  });

  it("shows nothing and requests nothing while the plugin is inactive", async () => {
    const backend = mount({ withCatalog: true, plugins: { todos: "inactive" } });
    await monthGrid();
    expect(await screen.findByTestId("calendar-event-row")).toHaveTextContent("School meeting");
    await waitFor(() => expect(backend.keys("GET /api/plugins")).not.toEqual([]));
    await showWeek();
    expect(document.querySelector("[data-calendar-day-slot] [type=checkbox]")).toBeNull();
    expect(backend.keys("GET /api/todos")).toEqual([]);
    // No room is kept for to-dos: the time grid has the whole week view.
    expect(screen.getByTestId("calendar-week-day-slots")).not.toHaveClass("h-24");
  });

  it("keeps the calendar working when the to-dos answer cannot be drawn", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const backend = mount({
        withCatalog: true,
        intercept: (key) =>
          key.startsWith("GET /api/todos?") ? json({ todos: "broken" }) : undefined,
        other: (key) => {
          if (key.startsWith("GET /api/calendar/events?")) return json([meeting]);
          if (key.startsWith("POST /api/plugins/todos/")) return json({}, 202);
          return undefined;
        },
      });
      await monthGrid();
      expect(await screen.findByTestId("plugin-unavailable")).toBeVisible();
      expect(screen.getByTestId("calendar-event-row")).toHaveTextContent("School meeting");
      expect(document.querySelector("[data-calendar-day-slot] [type=checkbox]")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Next period" }));
      expect(screen.getByTestId("calendar-period-title")).toHaveTextContent("October 2026");
      expect(backend.keys("POST /api/plugins/todos/")).not.toEqual([]);
    } finally {
      reported.mockRestore();
    }
  });
});
