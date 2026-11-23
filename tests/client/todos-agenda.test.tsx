import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TodayAgenda } from "@/home/TodayAgenda";
import { LanguageProvider } from "@/i18n";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { PluginCatalogProvider } from "@/plugins/PluginCatalogProvider";
import type { FeedItem } from "../../src/shared";
import { json } from "./helpers/fetchRoutes";
import { NOW, todosBackend, type TodosBackendOptions } from "./helpers/todosBackend";

const lists = [{ id: "home", name: "Casa" }];
const todos: TodosBackendOptions["todos"] = [
  { id: "undated", listId: "home", title: "Fix the tap" },
  { id: "older", listId: "home", title: "Renew passport", dueDate: "2026-09-18" },
  { id: "yesterday", listId: "home", title: "Pay the rent", dueDate: "2026-09-21" },
  {
    id: "today",
    listId: "home",
    title: "Call the plumber",
    dueDate: "2026-09-22",
    assigneeMemberId: "blair",
  },
  {
    id: "archived",
    listId: "home",
    title: "Sort mail",
    dueDate: "2026-09-22",
    assigneeMemberId: "eli",
  },
  { id: "future", listId: "home", title: "Book the van", dueDate: "2026-09-23" },
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

function mount(options: TodosBackendOptions & { events?: FeedItem[]; withCatalog?: boolean } = {}) {
  const { events = [meeting], withCatalog = false, ...backendOptions } = options;
  const backend = todosBackend({
    lists,
    todos,
    other: (key) => (key.startsWith("GET /api/calendar/events?") ? json(events) : undefined),
    ...backendOptions,
  });
  const agenda = (
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <TodayAgenda />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
  render(withCatalog ? <PluginCatalogProvider>{agenda}</PluginCatalogProvider> : agenda);
  return backend;
}

const group = () => screen.findByRole("list", { name: "To-dos" });
const rowOf = (title: string) => screen.getByRole("checkbox", { name: title }).closest("li")!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Home agenda to-dos group", () => {
  it("lists open to-dos due today first, then the overdue ones, after the event groups", async () => {
    const backend = mount();
    const list = await group();
    expect(
      within(list)
        .getAllByRole("checkbox")
        .map((checkbox) => checkbox.closest("label")?.textContent)
    ).toEqual(["Call the plumber", "Sort mail", "Renew passport", "Pay the rent"]);
    expect(backend.keys("GET /api/todos?")).toEqual([
      "GET /api/todos?status=open&dueBy=2026-09-22",
    ]);
    expect(
      within(screen.getByTestId("agenda-groups"))
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent)
    ).toEqual(["Scheduled", "To-dos"]);
    expect(screen.queryByText("Fix the tap")).not.toBeInTheDocument();
    expect(screen.queryByText("Book the van")).not.toBeInTheDocument();
    expect(screen.queryByText("Pay the deposit")).not.toBeInTheDocument();
  });

  it("marks overdue rows with their date and leaves today's rows unmarked", async () => {
    mount();
    await group();
    const overdue = rowOf("Renew passport");
    expect(within(overdue).getByText("Overdue")).toBeVisible();
    expect(overdue.querySelector("time")).toHaveAttribute("datetime", "2026-09-18");
    expect(overdue.querySelector("time")).toHaveTextContent("Fri, Sep 18");
    const today = rowOf("Call the plumber");
    expect(within(today).queryByText("Overdue")).not.toBeInTheDocument();
    expect(today.querySelector("time")).toBeNull();
  });

  it("shows the assignee like an event row: identity accent and names for assistive technology", async () => {
    mount();
    await group();
    const assigned = rowOf("Call the plumber");
    expect(assigned).toHaveClass("member-event-surface", "border-l-4", "border-l-member-pink-500");
    expect(assigned.style.getPropertyValue("--member-event-border")).toBe(
      "var(--color-member-pink-500)"
    );
    expect(within(assigned).getByTestId("agenda-details")).toHaveTextContent("Blair");
    expect(within(assigned).getByTestId("agenda-details")).toHaveClass("sr-only");

    const archived = rowOf("Sort mail");
    expect(archived).toHaveClass("border-l-transparent");
    expect(within(archived).getByTestId("agenda-details")).toHaveTextContent("Eli");

    expect(within(rowOf("Pay the rent")).getByTestId("agenda-details")).toHaveTextContent(
      "Unassigned"
    );
  });

  it("links the group header to the To-dos page", async () => {
    mount();
    await group();
    expect(screen.getByRole("link", { name: "All to-dos" })).toHaveAttribute("href", "/todos");
  });

  it("completes a to-do from its checkbox, drops the row and reads the group again", async () => {
    const backend = mount();
    await group();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pay the rent" }));
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Pay the rent" })).not.toBeInTheDocument()
    );
    expect(backend.keys("POST")).toEqual(["POST /api/todos/yesterday/completion"]);
    await waitFor(() => expect(backend.keys("GET /api/todos?")).toHaveLength(2));
    expect(screen.getByRole("checkbox", { name: "Renew passport" })).toBeVisible();
  });

  it("reports a completion that failed and keeps the row", async () => {
    mount({
      intercept: (key) =>
        key === "POST /api/todos/yesterday/completion"
          ? json({ error: "internal_error" }, 500)
          : undefined,
    });
    await group();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pay the rent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The change could not be saved.");
    expect(screen.getByRole("checkbox", { name: "Pay the rent" })).not.toBeChecked();
  });

  it("removes the group with its last row and then says nothing is scheduled", async () => {
    mount({
      events: [],
      todos: [{ id: "only", listId: "home", title: "Only one", dueDate: "2026-09-22" }],
    });
    await group();
    expect(screen.queryByText("Nothing scheduled today.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Only one" }));
    expect(await screen.findByText("Nothing scheduled today.")).toBeVisible();
    expect(screen.queryByRole("list", { name: "To-dos" })).not.toBeInTheDocument();
  });

  it("says nothing is scheduled only when there are neither events nor due to-dos", async () => {
    mount({
      events: [],
      todos: [{ id: "later", listId: "home", title: "Later", dueDate: "2026-09-23" }],
    });
    expect(await screen.findByText("Nothing scheduled today.")).toBeVisible();
    expect(screen.queryByRole("heading", { level: 3, name: "To-dos" })).not.toBeInTheDocument();
  });

  it("does not claim an empty day while the due to-dos are still loading", async () => {
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    mount({
      events: [],
      intercept: async (key) => {
        if (key.startsWith("GET /api/todos?")) await pending;
        return undefined;
      },
    });
    await screen.findByTestId("agenda-groups");
    expect(screen.queryByText("Nothing scheduled today.")).not.toBeInTheDocument();
    await act(async () => release());
    expect(await group()).toBeVisible();
    expect(screen.queryByText("Nothing scheduled today.")).not.toBeInTheDocument();
  });

  it("does not claim an empty day while the plugin catalog is still loading", async () => {
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    mount({
      withCatalog: true,
      events: [],
      intercept: async (key) => {
        if (key === "GET /api/plugins") await pending;
        return undefined;
      },
    });
    expect(await screen.findByRole("heading", { level: 2, name: "Tuesday, Sep 22" })).toBeVisible();
    expect(screen.queryByText("Nothing scheduled today.")).not.toBeInTheDocument();
    await act(async () => release());
    expect(await group()).toBeVisible();
    expect(screen.queryByText("Nothing scheduled today.")).not.toBeInTheDocument();
  });

  it("keeps the empty-day message where the agenda had it: padded, outside the groups scroller", async () => {
    mount({ events: [], todos: [] });
    const message = await screen.findByText("Nothing scheduled today.");
    expect(message).toHaveClass("py-4", "text-muted-foreground");
    expect(message.closest("[data-testid='agenda-groups']")).toBeNull();
    expect(message.parentElement).toBe(screen.getByRole("region", { name: "Today's agenda" }));
    expect(screen.getByTestId("agenda-groups")).not.toBeVisible();
  });

  it.each([
    // 2026-09-22T10:00Z is the 23rd in Kiritimati (UTC+14) and the 21st in Pago Pago (UTC-11).
    ["Pacific/Kiritimati", "2026-09-23", ["Due 23"], ["Due 20", "Due 21", "Due 22"]],
    ["Pacific/Pago_Pago", "2026-09-21", ["Due 21"], ["Due 20"]],
  ])(
    "asks for the to-dos due by the household date in %s and marks overdue against it",
    async (timezone, date, dueToday, overdue) => {
      const backend = mount({
        timezone,
        events: [],
        todos: ["20", "21", "22", "23", "24"].map((day) => ({
          id: day,
          listId: "home",
          title: `Due ${day}`,
          dueDate: `2026-09-${day}`,
        })),
      });
      const list = await group();
      expect(backend.keys("GET /api/todos?")).toEqual([`GET /api/todos?status=open&dueBy=${date}`]);
      const shown = within(list)
        .getAllByRole("checkbox")
        .map((checkbox) => checkbox.closest("label")?.textContent ?? "");
      expect(shown).toEqual([...dueToday, ...overdue]);
      expect(shown.filter((title) => within(rowOf(title)).queryByText("Overdue") !== null)).toEqual(
        overdue
      );
    }
  );

  it("disables a checkbox while its completion is on its way, and only that one", async () => {
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    const backend = mount({
      intercept: async (key) => {
        if (key === "POST /api/todos/yesterday/completion") await pending;
        return undefined;
      },
    });
    await group();
    const checkbox = screen.getByRole("checkbox", { name: "Pay the rent" });
    fireEvent.click(checkbox);
    expect(checkbox).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Renew passport" })).toBeEnabled();
    await act(async () => release());
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Pay the rent" })).not.toBeInTheDocument()
    );
    expect(backend.keys("POST")).toEqual(["POST /api/todos/yesterday/completion"]);
  });

  it("keeps the events and reports a failed to-dos read with its own retry", async () => {
    let failing = true;
    mount({
      intercept: (key) =>
        failing && key.startsWith("GET /api/todos?")
          ? json({ error: "internal_error", message: "private diagnostic" }, 500)
          : undefined,
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Due to-dos could not be loaded.");
    expect(screen.getByRole("heading", { level: 4, name: "School meeting" })).toBeVisible();
    expect(screen.queryByText("private diagnostic")).not.toBeInTheDocument();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry to-dos" }));
    expect(await screen.findByRole("checkbox", { name: "Call the plumber" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not read while the tablet is hidden", async () => {
    const backend = mount();
    await group();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(backend.keys("GET /api/todos?")).toHaveLength(1);
    } finally {
      visibility.mockRestore();
    }
  });

  it("keeps the newer answer when an older read arrives after it", async () => {
    let release!: () => void;
    const slow = new Promise<void>((done) => {
      release = done;
    });
    let reads = 0;
    const backend = mount({
      intercept: async (key) => {
        if (key.startsWith("GET /api/todos?") && ++reads === 1) {
          await slow;
          return json([]);
        }
        return undefined;
      },
    });
    await screen.findByTestId("agenda-groups");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByRole("checkbox", { name: "Call the plumber" })).toBeVisible();
    await act(async () => release());
    expect(screen.getByRole("checkbox", { name: "Call the plumber" })).toBeVisible();
    expect(backend.keys("GET /api/todos?")).toHaveLength(2);
  });

  it("ignores the failure of an older read once a newer one answered", async () => {
    let release!: () => void;
    const slow = new Promise<void>((done) => {
      release = done;
    });
    let reads = 0;
    mount({
      intercept: async (key) => {
        if (key.startsWith("GET /api/todos?") && ++reads === 1) {
          await slow;
          return json({ error: "internal_error" }, 500);
        }
        return undefined;
      },
    });
    await screen.findByTestId("agenda-groups");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByRole("checkbox", { name: "Call the plumber" })).toBeVisible();
    await act(async () => release());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Call the plumber" })).toBeVisible();
  });

  it("reads again when the tablet becomes visible", async () => {
    const backend = mount();
    await group();
    backend.todos.set("late", {
      ...backend.todo("today")!,
      id: "late",
      title: "Added from a phone",
      assigneeMemberId: null,
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByRole("checkbox", { name: "Added from a phone" })).toBeVisible();
    expect(backend.keys("GET /api/todos?")).toHaveLength(2);
  });

  it("reads the next household day after midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime("2026-09-22T23:59:59Z");
    const backend = mount({ events: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("checkbox", { name: "Book the van" })).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("checkbox", { name: "Book the van" })).toBeVisible();
    expect(backend.keys("GET /api/todos?").at(-1)).toBe(
      "GET /api/todos?status=open&dueBy=2026-09-23"
    );
    expect(within(rowOf("Call the plumber")).getByText("Overdue")).toBeVisible();
  });

  it("labels the group Pendientes in Spanish", async () => {
    mount({ language: "es" });
    expect(await screen.findByRole("list", { name: "Pendientes" })).toBeVisible();
    expect(within(rowOf("Renew passport")).getByText("Vencido")).toBeVisible();
    expect(screen.getByRole("link", { name: "Todos los pendientes" })).toBeVisible();
  });
});

describe("Home agenda to-dos group and the plugin lifecycle", () => {
  it("shows the group while the plugin is active", async () => {
    mount({ withCatalog: true });
    expect(await group()).toBeVisible();
  });

  it("shows nothing and requests nothing while the plugin is inactive", async () => {
    const backend = mount({ withCatalog: true, plugins: { todos: "inactive" } });
    expect(await screen.findByRole("heading", { level: 4, name: "School meeting" })).toBeVisible();
    await waitFor(() => expect(backend.keys("GET /api/plugins")).toHaveLength(1));
    expect(screen.queryByRole("heading", { level: 3, name: "To-dos" })).not.toBeInTheDocument();
    expect(backend.keys("GET /api/todos")).toEqual([]);
  });

  it("still says nothing is scheduled on an empty day while the plugin is inactive", async () => {
    mount({ withCatalog: true, plugins: { todos: "inactive" }, events: [] });
    expect(await screen.findByText("Nothing scheduled today.")).toBeVisible();
  });
});
