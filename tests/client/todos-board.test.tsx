import { useEffect, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { AdminUnlockProvider, useAdminUnlock } from "@/lib/adminUnlock";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { TodosBoard } from "@/todos/TodosBoard";
import { json } from "./helpers/fetchRoutes";
import { ADMIN_PIN, NOW, todosBackend, type TodosBackendOptions } from "./helpers/todosBackend";

/** A request the test answers only when it calls `release`. */
function held() {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  return { gate, release: () => act(async () => release()) };
}

const lists = [
  { id: "home", name: "Casa" },
  { id: "move", name: "Mudanza de casa" },
];
const todos: TodosBackendOptions["todos"] = [
  { id: "undated", listId: "home", title: "Fix the tap" },
  { id: "overdue", listId: "home", title: "Renew passport", dueDate: "2026-09-18" },
  {
    id: "today",
    listId: "home",
    title: "Call the plumber",
    dueDate: "2026-09-22",
    assigneeMemberId: "blair",
    notes: "Ask about the boiler",
  },
  { id: "future", listId: "home", title: "Book the van", dueDate: "2026-10-03" },
  { id: "finished", listId: "home", title: "Pay the deposit", completedAt: 5 },
  { id: "boxes", listId: "move", title: "Buy boxes", assigneeMemberId: "eli" },
];

function mount(
  options: TodosBackendOptions = {},
  wrap: (board: ReactNode) => ReactNode = (board) => board
) {
  const backend = todosBackend({ lists, todos, ...options });
  render(
    <HouseholdSettingsProvider>
      <LanguageProvider>{wrap(<TodosBoard />)}</LanguageProvider>
    </HouseholdSettingsProvider>
  );
  return backend;
}

const openList = () => screen.findByRole("list", { name: "Open to-dos" });
const pinDialog = () => screen.findByRole("dialog", { name: "Admin PIN" });
function typePin(pin: string) {
  for (const digit of pin) fireEvent.click(screen.getByRole("button", { name: `Digit ${digit}` }));
}
/** Presses "Delete list" and enters the admin PIN the deletion asks for. */
async function unlockListDeletion() {
  fireEvent.click(screen.getByRole("button", { name: "Delete list" }));
  await pinDialog();
  typePin(ADMIN_PIN);
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Admin PIN" })).not.toBeInTheDocument()
  );
}
const titles = (list: HTMLElement) =>
  within(list)
    .getAllByRole("checkbox")
    .map((checkbox) => checkbox.closest("label")?.textContent);
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

describe("TodosBoard lists", () => {
  it("shows one pill per list with its open count and selects the first list", async () => {
    const backend = mount();
    const pills = await screen.findByRole("radiogroup", { name: "Lists" });
    expect(
      within(pills)
        .getAllByRole("radio")
        .map((radio) => [radio.closest("label")?.textContent, (radio as HTMLInputElement).checked])
    ).toEqual([
      ["Casa (4)", true],
      ["Mudanza de casa (1)", false],
    ]);
    expect(screen.getByRole("heading", { level: 1, name: "To-dos" })).toBeVisible();
    await openList();
    expect(backend.keys("GET /api/todos?")).toEqual(["GET /api/todos?listId=home&status=open"]);
  });

  it("loads the to-dos of the list that is picked", async () => {
    mount();
    await openList();
    fireEvent.click(screen.getByRole("radio", { name: "Mudanza de casa (1)" }));
    expect(await screen.findByRole("checkbox", { name: "Buy boxes" })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "Fix the tap" })).not.toBeInTheDocument();
  });

  it("invites to create the first list when there is none", async () => {
    const backend = mount({ lists: [], todos: [] });
    expect(
      await screen.findByText(
        "There are no lists yet. Create the first one to start adding to-dos."
      )
    ).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "New to-do" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create the first list" }));
    const dialog = await screen.findByRole("dialog", { name: "New list" });
    fireEvent.change(within(dialog).getByLabelText("List name"), {
      target: { value: "  Paperwork " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("radio", { name: "Paperwork (0)" })).toBeChecked();
    expect(backend.bodies("POST /api/todos/lists")).toEqual([{ name: "Paperwork" }]);
    expect(screen.getByText("Nothing pending in this list.")).toBeVisible();
  });

  it("creates a list from the selector and selects it", async () => {
    mount();
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "New list" }));
    const dialog = await screen.findByRole("dialog", { name: "New list" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter a name.");
    fireEvent.change(within(dialog).getByLabelText("List name"), { target: { value: "Casa" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Another list already has that name."
    );
    fireEvent.change(within(dialog).getByLabelText("List name"), { target: { value: "Garden" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("radio", { name: "Garden (0)" })).toBeChecked();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await screen.findByText("Nothing pending in this list.")).toBeVisible();
  });

  it("renames the selected list", async () => {
    const backend = mount();
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "Rename list" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename list" });
    expect(within(dialog).getByLabelText("List name")).toHaveValue("Casa");
    fireEvent.change(within(dialog).getByLabelText("List name"), { target: { value: "Home" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("radio", { name: "Home (4)" })).toBeChecked();
    expect(backend.bodies("PATCH /api/todos/lists/home")).toEqual([{ name: "Home" }]);
  });

  it("asks before deleting a list and says how many to-dos go with it", async () => {
    const backend = mount();
    await openList();
    await unlockListDeletion();
    const dialog = await screen.findByRole("dialog", { name: "Delete the list “Casa”?" });
    expect(await within(dialog).findByText("Its 5 to-dos are deleted with it.")).toBeVisible();
    expect(backend.keys("GET /api/todos?listId=home&status=all")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(backend.keys("DELETE")).toEqual([]);

    await unlockListDeletion();
    await screen.findByText("Its 5 to-dos are deleted with it.");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("radio", { name: "Mudanza de casa (1)" })).toBeChecked();
    expect(screen.queryByRole("radio", { name: /Casa/ })).not.toBeInTheDocument();
    expect(backend.keys("DELETE")).toEqual(["DELETE /api/todos/lists/home"]);
    expect(await screen.findByRole("checkbox", { name: "Buy boxes" })).toBeVisible();
  });

  it("still warns about the to-dos when their count cannot be read", async () => {
    mount({
      intercept: (key) =>
        key === "GET /api/todos?listId=home&status=all"
          ? json({ error: "internal" }, 500)
          : undefined,
    });
    await openList();
    await unlockListDeletion();
    expect(
      await screen.findByText("Its to-dos could not be counted. All of them are deleted with it.")
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("keeps Delete disabled until the number of to-dos that go with the list is known", async () => {
    const count = held();
    const backend = mount({
      intercept: async (key) => {
        if (key === "GET /api/todos?listId=home&status=all") await count.gate;
        return undefined;
      },
    });
    await openList();
    await unlockListDeletion();
    const dialog = await screen.findByRole("dialog", { name: "Delete the list “Casa”?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByText("Counting its to-dos…")).toBeVisible();
    fireEvent.click(confirm);
    expect(backend.keys("DELETE")).toEqual([]);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();

    await count.release();
    expect(await within(dialog).findByText("Its 5 to-dos are deleted with it.")).toBeVisible();
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(backend.keys("DELETE")).toEqual(["DELETE /api/todos/lists/home"]));
  });

  it("drops a count that arrives after the deletion question was closed", async () => {
    const count = held();
    mount({
      intercept: async (key) => {
        if (key === "GET /api/todos?listId=home&status=all") await count.gate;
        return undefined;
      },
    });
    await openList();
    await unlockListDeletion();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await count.release();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Casa (4)" })).toBeChecked();
  });

  it("keeps the list dialog open on Escape while its save is on its way", async () => {
    const save = held();
    mount({
      intercept: async (key) => {
        if (key === "POST /api/todos/lists") await save.gate;
        return undefined;
      },
    });
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "New list" }));
    const dialog = await screen.findByRole("dialog", { name: "New list" });
    fireEvent.change(within(dialog).getByLabelText("List name"), { target: { value: "Garden" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "New list" })).toBeVisible();
    await save.release();
    expect(await screen.findByRole("radio", { name: "Garden (0)" })).toBeChecked();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reports a deletion that failed and keeps the list", async () => {
    mount({
      intercept: (key) =>
        key === "DELETE /api/todos/lists/home" ? json({ error: "internal" }, 500) : undefined,
    });
    await openList();
    await unlockListDeletion();
    await screen.findByText("Its 5 to-dos are deleted with it.");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The change could not be saved.");
    expect(screen.getByRole("radio", { name: "Casa (4)" })).toBeChecked();
  });

  it("closes the list dialog on Cancel and on Escape without a request", async () => {
    const backend = mount();
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "New list" }));
    const created = await screen.findByRole("dialog", { name: "New list" });
    fireEvent.change(within(created).getByLabelText("List name"), { target: { value: "Garden" } });
    fireEvent.click(within(created).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename list" }));
    const renamed = await screen.findByRole("dialog", { name: "Rename list" });
    fireEvent.keyDown(renamed, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.keys("POST")).toEqual([]);
    expect(backend.keys("PATCH")).toEqual([]);
    expect(screen.queryByRole("radio", { name: /Garden/ })).not.toBeInTheDocument();
  });

  it.each([
    [[], "The list has no to-dos."],
    [[{ id: "only", listId: "home", title: "Only one" }], "Its 1 to-do is deleted with it."],
  ])("words the deletion warning for a list with %j", async (seed, warning) => {
    mount({ lists: [lists[0]], todos: seed });
    await screen.findByRole("radiogroup", { name: "Lists" });
    await unlockListDeletion();
    expect(await screen.findByText(warning)).toBeVisible();
  });

  it.each(["Budget $$", "A $& B", "$1 and $`", "Gastos {count} casa", "{name}"])(
    "writes the list name %j as it is stored, in the selector and in the deletion question",
    async (name) => {
      mount({ lists: [{ id: "odd", name }], todos: [] });
      expect(await screen.findByRole("radio", { name: `${name} (0)` })).toBeChecked();
      expect(screen.getByRole("heading", { level: 2, name })).toBeVisible();
      await unlockListDeletion();
      expect(
        await screen.findByRole("dialog", { name: `Delete the list “${name}”?` })
      ).toBeVisible();
    }
  );

  it("orders the lists as the household reads them, accented names in their place", async () => {
    const names = ["zeta", "Árbol", "Home", "alfa", "Ñu", "Beta", "nube"];
    mount({
      language: "es",
      lists: names.map((name) => ({ id: name, name })),
      todos: [],
    });
    await screen.findByRole("heading", { level: 1, name: "Pendientes" });
    const shown = () =>
      within(screen.getByRole("radiogroup", { name: "Listas" }))
        .getAllByRole("radio")
        .map((radio) => radio.closest("label")?.textContent);
    await waitFor(() =>
      expect(shown()).toEqual([
        "alfa (0)",
        "Árbol (0)",
        "Beta (0)",
        "Home (0)",
        "nube (0)",
        "Ñu (0)",
        "zeta (0)",
      ])
    );
    fireEvent.click(screen.getByRole("button", { name: "Añadir con detalles" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuevo pendiente" });
    expect(
      [...within(dialog).getByLabelText<HTMLSelectElement>("Lista").options].map(
        (option) => option.textContent
      )
    ).toEqual(["alfa", "Árbol", "Beta", "Home", "nube", "Ñu", "zeta"]);
  });

  it("selects the first list in reading order, not the first the API returns", async () => {
    const backend = mount({
      lists: [
        { id: "zeta", name: "Zeta" },
        { id: "arbol", name: "Árbol" },
      ],
      todos: [{ id: "prune", listId: "arbol", title: "Prune it" }],
    });
    expect(await screen.findByRole("radio", { name: "Árbol (1)" })).toBeChecked();
    expect(await screen.findByRole("checkbox", { name: "Prune it" })).toBeVisible();
    expect(backend.keys("GET /api/todos?")).toEqual(["GET /api/todos?listId=arbol&status=open"]);
  });
});

describe("TodosBoard list deletion and the admin PIN", () => {
  it("asks for the admin PIN before the deletion question and deletes after the right one", async () => {
    const backend = mount();
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "Delete list" }));
    const pad = await pinDialog();
    expect(within(pad).getByText("Enter the admin PIN to delete the list “Casa”.")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Delete the list “Casa”?" })).toBeNull();
    expect(backend.keys("GET /api/todos?listId=home&status=all")).toEqual([]);

    typePin(ADMIN_PIN);
    const confirm = await screen.findByRole("dialog", { name: "Delete the list “Casa”?" });
    expect(screen.queryByRole("dialog", { name: "Admin PIN" })).toBeNull();
    expect(backend.bodies("POST /api/auth/verify-pin")).toEqual([{ pin: ADMIN_PIN }]);
    expect(backend.keys("DELETE")).toEqual([]);
    await within(confirm).findByText("Its 5 to-dos are deleted with it.");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(backend.keys("DELETE")).toEqual(["DELETE /api/todos/lists/home"]));
  });

  it("leaves the list alone after a wrong PIN", async () => {
    const backend = mount();
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "Delete list" }));
    const pad = await pinDialog();
    typePin("1111");
    fireEvent.click(within(pad).getByRole("button", { name: "Unlock Admin" }));
    expect(await within(pad).findByRole("alert")).toHaveTextContent("Incorrect PIN.");
    expect(screen.queryByRole("dialog", { name: "Delete the list “Casa”?" })).toBeNull();

    fireEvent.click(within(pad).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(backend.keys("DELETE")).toEqual([]);
    expect(backend.keys("GET /api/todos?listId=home&status=all")).toEqual([]);
    expect(backend.lists.has("home")).toBe(true);
    expect(screen.getByRole("radio", { name: "Casa (4)" })).toBeChecked();
  });

  it("closes the PIN entry on Escape without deleting", async () => {
    const backend = mount();
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "Delete list" }));
    fireEvent.keyDown(await pinDialog(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.keys("POST /api/auth/verify-pin")).toEqual([]);
    expect(backend.lists.has("home")).toBe(true);
  });

  it("asks for the PIN again for the next deletion", async () => {
    const backend = mount();
    await openList();
    await unlockListDeletion();
    await screen.findByText("Its 5 to-dos are deleted with it.");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("radio", { name: "Mudanza de casa (1)" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Delete list" }));
    expect(await pinDialog()).toBeVisible();
    expect(backend.keys("DELETE")).toEqual(["DELETE /api/todos/lists/home"]);
  });

  it("goes straight to the deletion question while the admin session is unlocked", async () => {
    function Unlocked({ children }: { children: ReactNode }) {
      const { setUnlocked } = useAdminUnlock();
      useEffect(() => setUnlocked(true), [setUnlocked]);
      return children;
    }
    const backend = mount({}, (board) => (
      <AdminUnlockProvider>
        <Unlocked>{board}</Unlocked>
      </AdminUnlockProvider>
    ));
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "Delete list" }));
    expect(await screen.findByRole("dialog", { name: "Delete the list “Casa”?" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Admin PIN" })).toBeNull();
    expect(backend.keys("POST /api/auth/verify-pin")).toEqual([]);
  });

  it("needs no PIN to create or rename a list, or to add, edit, complete or delete a to-do", async () => {
    const backend = mount();
    await openList();

    fireEvent.click(screen.getByRole("button", { name: "New list" }));
    const created = await screen.findByRole("dialog", { name: "New list" });
    fireEvent.change(within(created).getByLabelText("List name"), { target: { value: "Garden" } });
    fireEvent.click(within(created).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("radio", { name: "Garden (0)" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Rename list" }));
    const renamed = await screen.findByRole("dialog", { name: "Rename list" });
    fireEvent.change(within(renamed).getByLabelText("List name"), { target: { value: "Yard" } });
    fireEvent.click(within(renamed).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("radio", { name: "Yard (0)" })).toBeChecked();

    const input = screen.getByRole("textbox", { name: "New to-do" });
    fireEvent.change(input, { target: { value: "Mow" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Edit: Mow" }));
    const edit = await screen.findByRole("dialog", { name: "Edit to-do" });
    fireEvent.change(within(edit).getByLabelText("Title"), { target: { value: "Mow the lawn" } });
    fireEvent.click(within(edit).getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Mow the lawn" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Yard (0)" })).toBeChecked());

    fireEvent.change(input, { target: { value: "Rake" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Edit: Rake" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Edit to-do" })).getByRole("button", {
        name: "Delete",
      })
    );
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Delete this to-do?" })).getByRole(
        "button",
        { name: "Delete" }
      )
    );
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Rake" })).not.toBeInTheDocument()
    );

    expect(backend.keys("POST /api/auth/verify-pin")).toEqual([]);
    expect(
      backend
        .keys()
        .filter((key) => !key.startsWith("GET"))
        .map((key) => key.replace(/(list|todo)-\d+/, "$1-N"))
    ).toEqual([
      "POST /api/todos/lists",
      "PATCH /api/todos/lists/list-N",
      "POST /api/todos",
      "PATCH /api/todos/todo-N",
      "POST /api/todos/todo-N/completion",
      "POST /api/todos",
      "DELETE /api/todos/todo-N",
    ]);
  });
});

describe("TodosBoard to-dos", () => {
  it("lists open to-dos in API order with due date, overdue mark and assignee", async () => {
    mount();
    const list = await openList();
    expect(titles(list)).toEqual([
      "Renew passport",
      "Call the plumber",
      "Book the van",
      "Fix the tap",
    ]);

    const overdue = rowOf("Renew passport");
    expect(within(overdue).getByText("Overdue")).toBeVisible();
    expect(overdue.querySelector("time")).toHaveAttribute("datetime", "2026-09-18");
    expect(overdue.querySelector("time")).toHaveTextContent("Fri, Sep 18");

    const today = rowOf("Call the plumber");
    expect(within(today).queryByText("Overdue")).not.toBeInTheDocument();
    expect(today.querySelector("time")).toHaveTextContent("Tue, Sep 22");
    const assignee = within(today).getByTestId("todo-assignee");
    expect(assignee).toHaveTextContent("Blair");
    expect(assignee.querySelector("[aria-hidden='true']")).toHaveClass("bg-member-pink-500");

    expect(within(rowOf("Book the van")).queryByText("Overdue")).not.toBeInTheDocument();
    const undated = rowOf("Fix the tap");
    expect(undated.querySelector("time")).toBeNull();
    expect(within(undated).queryByTestId("todo-assignee")).not.toBeInTheDocument();
  });

  it("writes the year of a due date in another year", async () => {
    mount({ todos: [{ id: "old", listId: "home", title: "Old", dueDate: "2025-12-30" }] });
    await openList();
    expect(rowOf("Old").querySelector("time")).toHaveTextContent("Tue, Dec 30, 2025");
  });

  it("names an archived assignee without an identity colour", async () => {
    mount();
    await openList();
    fireEvent.click(screen.getByRole("radio", { name: "Mudanza de casa (1)" }));
    await screen.findByRole("checkbox", { name: "Buy boxes" });
    const assignee = within(rowOf("Buy boxes")).getByTestId("todo-assignee");
    expect(assignee).toHaveTextContent("Eli");
    expect(assignee.querySelector("[class*='bg-member-']")).toBeNull();
  });

  it("says when the selected list has nothing pending", async () => {
    mount({
      todos: [{ id: "finished", listId: "home", title: "Pay the deposit", completedAt: 5 }],
    });
    expect(await screen.findByText("Nothing pending in this list.")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Open to-dos" })).not.toBeInTheDocument();
  });

  it("creates a to-do in the selected list on Enter and clears the field", async () => {
    const backend = mount();
    await openList();
    const input = screen.getByRole("textbox", { name: "New to-do" });
    fireEvent.submit(input.closest("form")!);
    expect(backend.keys("POST")).toEqual([]);
    fireEvent.change(input, { target: { value: "  Water the plants  " } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("checkbox", { name: "Water the plants" })).toBeVisible();
    expect(backend.bodies("POST /api/todos")).toEqual([
      { listId: "home", title: "Water the plants" },
    ]);
    expect(input).toHaveValue("");
    expect(screen.getByRole("radio", { name: "Casa (5)" })).toBeChecked();
  });

  it("keeps the typed title and reports a failed quick add", async () => {
    mount({
      intercept: (key) =>
        key === "POST /api/todos" ? json({ error: "internal" }, 500) : undefined,
    });
    await openList();
    const input = screen.getByRole("textbox", { name: "New to-do" });
    fireEvent.change(input, { target: { value: "Water the plants" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("The change could not be saved.");
    expect(input).toHaveValue("Water the plants");
    expect(screen.getByRole("button", { name: "Add" })).toBeEnabled();
  });

  it("creates one to-do when the quick add is submitted again before the first answer", async () => {
    const post = held();
    const backend = mount({
      intercept: async (key) => {
        if (key === "POST /api/todos") await post.gate;
        return undefined;
      },
    });
    await openList();
    const input = screen.getByRole("textbox", { name: "New to-do" });
    const add = screen.getByRole("button", { name: "Add" });
    fireEvent.change(input, { target: { value: "Water the plants" } });
    fireEvent.submit(input.closest("form")!);
    expect(add).toBeDisabled();
    fireEvent.submit(input.closest("form")!);
    fireEvent.submit(input.closest("form")!);

    await post.release();
    expect(await screen.findByRole("checkbox", { name: "Water the plants" })).toBeVisible();
    expect(backend.keys("POST")).toEqual(["POST /api/todos"]);
    expect(
      [...backend.todos.values()].filter((todo) => todo.title === "Water the plants")
    ).toHaveLength(1);
    await waitFor(() => expect(add).toBeEnabled());
    expect(input).toHaveValue("");
  });

  it("does not send a quick add whose title shows nothing", async () => {
    const backend = mount();
    await openList();
    const input = screen.getByRole("textbox", { name: "New to-do" });
    fireEvent.change(input, { target: { value: " \u200B\u200D " } });
    fireEvent.submit(input.closest("form")!);
    expect(backend.keys("POST")).toEqual([]);
  });

  it.each([
    ["Pacific/Kiritimati", ["Three days ago", "Two days ago", "Yesterday in UTC", "Today in UTC"]],
    ["Pacific/Pago_Pago", ["Three days ago", "Two days ago"]],
  ])("marks overdue by the household date in %s, not by UTC", async (timezone, overdue) => {
    // 2026-09-22T10:00Z is the 23rd in Kiritimati (UTC+14) and the 21st in Pago Pago (UTC-11).
    mount({
      timezone,
      todos: [
        { id: "a", listId: "home", title: "Three days ago", dueDate: "2026-09-19" },
        { id: "b", listId: "home", title: "Two days ago", dueDate: "2026-09-20" },
        { id: "c", listId: "home", title: "Yesterday in UTC", dueDate: "2026-09-21" },
        { id: "d", listId: "home", title: "Today in UTC", dueDate: "2026-09-22" },
        { id: "e", listId: "home", title: "Tomorrow in UTC", dueDate: "2026-09-23" },
      ],
    });
    const list = await openList();
    await waitFor(() =>
      expect(
        titles(list).filter((title) => within(rowOf(title!)).queryByText("Overdue") !== null)
      ).toEqual(overdue)
    );
  });

  it("marks a to-do overdue when the household day ends, without a reload", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime("2026-09-22T23:59:59Z");
    const backend = mount();
    for (let round = 0; round < 5; round++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }
    expect(within(rowOf("Call the plumber")).queryByText("Overdue")).not.toBeInTheDocument();
    const reads = backend.requests.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(within(rowOf("Call the plumber")).getByText("Overdue")).toBeVisible();
    expect(within(rowOf("Book the van")).queryByText("Overdue")).not.toBeInTheDocument();
    expect(backend.requests).toHaveLength(reads);
  });

  it("marks a to-do overdue when the tablet wakes on a later household day", async () => {
    mount();
    await openList();
    expect(within(rowOf("Call the plumber")).queryByText("Overdue")).not.toBeInTheDocument();
    vi.setSystemTime("2026-09-23T06:00:00Z");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(within(rowOf("Call the plumber")).getByText("Overdue")).toBeVisible();
  });

  it("completes a to-do from its checkbox and takes it off the open list", async () => {
    const backend = mount();
    await openList();
    fireEvent.click(screen.getByRole("checkbox", { name: "Fix the tap" }));
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Fix the tap" })).not.toBeInTheDocument()
    );
    expect(backend.keys("POST")).toEqual(["POST /api/todos/undated/completion"]);
    expect(screen.getByRole("radio", { name: "Casa (3)" })).toBeChecked();
  });

  it("reports a completion that failed and keeps the to-do open", async () => {
    mount({
      intercept: (key) =>
        key === "POST /api/todos/undated/completion" ? json({ error: "internal" }, 500) : undefined,
    });
    await openList();
    fireEvent.click(screen.getByRole("checkbox", { name: "Fix the tap" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The change could not be saved.");
    expect(screen.getByRole("checkbox", { name: "Fix the tap" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Fix the tap" })).toBeEnabled();
  });

  it("disables a checkbox while its completion is on its way, and only that one", async () => {
    const completion = held();
    const backend = mount({
      intercept: async (key) => {
        if (key === "POST /api/todos/undated/completion") await completion.gate;
        return undefined;
      },
    });
    await openList();
    const checkbox = screen.getByRole("checkbox", { name: "Fix the tap" });
    fireEvent.click(checkbox);
    expect(checkbox).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Book the van" })).toBeEnabled();

    await completion.release();
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Fix the tap" })).not.toBeInTheDocument()
    );
    expect(backend.keys("POST")).toEqual(["POST /api/todos/undated/completion"]);
  });

  it("keeps Done collapsed, loads it on demand and reopens an unchecked to-do", async () => {
    const backend = mount();
    await openList();
    const toggle = screen.getByRole("button", { name: "Done" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(backend.keys("GET /api/todos?listId=home&status=done")).toEqual([]);
    expect(screen.queryByRole("list", { name: "Done to-dos" })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const done = await screen.findByRole("list", { name: "Done to-dos" });
    const finished = within(done).getByRole("checkbox", { name: "Pay the deposit" });
    expect(finished).toBeChecked();

    fireEvent.click(finished);
    expect(
      await within(await openList()).findByRole("checkbox", { name: "Pay the deposit" })
    ).not.toBeChecked();
    expect(backend.keys("DELETE")).toEqual(["DELETE /api/todos/finished/completion"]);
    expect(await screen.findByText("Nothing done in this list yet.")).toBeVisible();

    fireEvent.click(screen.getByRole("checkbox", { name: "Fix the tap" }));
    expect(
      await within(await screen.findByRole("list", { name: "Done to-dos" })).findByRole(
        "checkbox",
        { name: "Fix the tap" }
      )
    ).toBeChecked();
  });

  it("collapses Done on a second tap", async () => {
    mount();
    await openList();
    const toggle = screen.getByRole("button", { name: "Done" });
    fireEvent.click(toggle);
    await screen.findByRole("list", { name: "Done to-dos" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Done to-dos" })).not.toBeInTheDocument();
  });

  it("collapses Done again when another list is picked", async () => {
    mount();
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByRole("list", { name: "Done to-dos" });
    fireEvent.click(screen.getByRole("radio", { name: "Mudanza de casa (1)" }));
    await screen.findByRole("checkbox", { name: "Buy boxes" });
    expect(screen.getByRole("button", { name: "Done" })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("TodosBoard dialog", () => {
  async function openCreateDialog() {
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "Add with details" }));
    return screen.findByRole("dialog", { name: "New to-do" });
  }

  it("offers only active adults as assignees", async () => {
    mount();
    const dialog = await openCreateDialog();
    expect(
      within(dialog)
        .getAllByRole("checkbox")
        .map((checkbox) => checkbox.closest("label")?.textContent)
    ).toEqual(["Blair", "Dana"]);
    expect(within(dialog).getAllByRole("group", { name: "Assigned to" })).not.toHaveLength(0);
    expect(within(dialog).queryByRole("checkbox", { name: /Alex|Eli/ })).not.toBeInTheDocument();
  });

  it("adds a to-do with every field and carries the quick-add text into the form", async () => {
    const backend = mount();
    await openList();
    fireEvent.change(screen.getByRole("textbox", { name: "New to-do" }), {
      target: { value: "Hire movers" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add with details" }));
    const dialog = await screen.findByRole("dialog", { name: "New to-do" });
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Hire movers");
    expect(within(dialog).getByLabelText("List")).toHaveValue("home");

    fireEvent.change(within(dialog).getByLabelText("Notes"), { target: { value: "Two quotes" } });
    fireEvent.change(within(dialog).getByLabelText("Due date"), {
      target: { value: "2026-09-30" },
    });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Blair" }));
    // Picking a second adult replaces the first: a to-do has at most one assignee.
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Dana" }));
    expect(within(dialog).getByRole("checkbox", { name: "Blair" })).not.toBeChecked();
    fireEvent.change(within(dialog).getByLabelText("List"), { target: { value: "move" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.bodies("POST /api/todos")).toEqual([
      {
        listId: "move",
        title: "Hire movers",
        notes: "Two quotes",
        dueDate: "2026-09-30",
        assigneeMemberId: "dana",
      },
    ]);
    expect(screen.getByRole("textbox", { name: "New to-do" })).toHaveValue("");
    expect(await screen.findByRole("radio", { name: "Mudanza de casa (2)" })).toBeVisible();
  });

  it("allows nobody as assignee and requires a title", async () => {
    const backend = mount();
    const dialog = await openCreateDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter a title.");
    expect(backend.keys("POST")).toEqual([]);

    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Sort mail" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Blair" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Blair" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.bodies("POST /api/todos")).toEqual([{ listId: "home", title: "Sort mail" }]);
  });

  it("edits a to-do and sends only what changed", async () => {
    const backend = mount();
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "Edit: Call the plumber" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit to-do" });
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Call the plumber");
    expect(within(dialog).getByLabelText("Notes")).toHaveValue("Ask about the boiler");
    expect(within(dialog).getByLabelText("Due date")).toHaveValue("2026-09-22");
    expect(within(dialog).getByLabelText("List")).toHaveValue("home");
    expect(within(dialog).getByRole("checkbox", { name: "Blair" })).toBeChecked();

    fireEvent.change(within(dialog).getByLabelText("Title"), {
      target: { value: "Call the electrician" },
    });
    fireEvent.change(within(dialog).getByLabelText("Notes"), { target: { value: "" } });
    fireEvent.change(within(dialog).getByLabelText("Due date"), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Blair" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.bodies("PATCH /api/todos/today")).toEqual([
      { title: "Call the electrician", notes: null, dueDate: null, assigneeMemberId: null },
    ]);
    expect(await screen.findByRole("checkbox", { name: "Call the electrician" })).toBeVisible();
  });

  it("moves a to-do to another list from the edit dialog", async () => {
    const backend = mount();
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "Edit: Fix the tap" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit to-do" });
    fireEvent.change(within(dialog).getByLabelText("List"), { target: { value: "move" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Fix the tap" })).not.toBeInTheDocument()
    );
    expect(backend.bodies("PATCH /api/todos/undated")).toEqual([{ listId: "move" }]);
    expect(screen.getByRole("radio", { name: "Mudanza de casa (2)" })).toBeVisible();
  });

  it("closes an unchanged edit without a request", async () => {
    const backend = mount();
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "Edit: Fix the tap" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit to-do" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.keys("PATCH")).toEqual([]);
  });

  it("keeps an archived assignee selectable and leaves it alone unless it is changed", async () => {
    const backend = mount();
    await openList();
    fireEvent.click(screen.getByRole("radio", { name: "Mudanza de casa (1)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit: Buy boxes" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit to-do" });
    expect(within(dialog).getByRole("checkbox", { name: "Eli" })).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Buy 20 boxes" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.bodies("PATCH /api/todos/boxes")).toEqual([{ title: "Buy 20 boxes" }]);
  });

  it("keeps the dialog open and reports a rejected save", async () => {
    mount({
      intercept: (key) =>
        key === "PATCH /api/todos/undated"
          ? json({ error: "validation_error", message: "private detail" }, 400)
          : undefined,
    });
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "Edit: Fix the tap" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit to-do" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Fix it" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The change could not be saved."
    );
    expect(screen.queryByText("private detail")).not.toBeInTheDocument();
  });

  it("keeps the to-do dialog open on Escape while its save is on its way", async () => {
    const save = held();
    mount({
      intercept: async (key) => {
        if (key === "PATCH /api/todos/undated") await save.gate;
        return undefined;
      },
    });
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "Edit: Fix the tap" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit to-do" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Fix it" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Edit to-do" })).toBeVisible();
    await save.release();
    expect(await screen.findByRole("checkbox", { name: "Fix it" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("deletes a to-do from the edit dialog after confirmation", async () => {
    const backend = mount();
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "Edit: Fix the tap" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit to-do" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete this to-do?" });
    expect(backend.keys("DELETE")).toEqual([]);
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Fix the tap" })).not.toBeInTheDocument()
    );
    expect(backend.keys("DELETE")).toEqual(["DELETE /api/todos/undated"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Casa (3)" })).toBeChecked();
  });

  it("discards the form on Cancel and on Escape", async () => {
    const backend = mount();
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "Edit: Fix the tap" }));
    const edit = await screen.findByRole("dialog", { name: "Edit to-do" });
    fireEvent.change(within(edit).getByLabelText("Title"), { target: { value: "Changed" } });
    fireEvent.click(within(edit).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit: Fix the tap" }));
    const again = await screen.findByRole("dialog", { name: "Edit to-do" });
    expect(within(again).getByLabelText("Title")).toHaveValue("Fix the tap");
    fireEvent.keyDown(again, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.keys("PATCH")).toEqual([]);
  });

  it("keeps the to-do when its deletion is cancelled or fails", async () => {
    const backend = mount({
      intercept: (key) =>
        key === "DELETE /api/todos/undated" ? json({ error: "internal" }, 500) : undefined,
    });
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "Edit: Fix the tap" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit to-do" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Delete this to-do?" })).getByRole(
        "button",
        { name: "Cancel" }
      )
    );
    expect(backend.keys("DELETE")).toEqual([]);

    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Edit to-do" })).getByRole("button", {
        name: "Delete",
      })
    );
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Delete this to-do?" })).getByRole(
        "button",
        { name: "Delete" }
      )
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("The change could not be saved.");
    expect(backend.todo("undated")).toBeDefined();
  });

  it("has no delete action while creating", async () => {
    mount();
    const dialog = await openCreateDialog();
    expect(within(dialog).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });
});

describe("TodosBoard repeating to-dos", () => {
  const filter = {
    id: "filter",
    listId: "home",
    title: "Change the filter",
    dueDate: "2026-09-22",
    assigneeMemberId: "dana",
    repeat: { every: 2, unit: "week" },
  } as const;
  const withFilter = [...todos!, filter];

  async function openCreateDialog() {
    await openList();
    fireEvent.click(screen.getByRole("button", { name: "Add with details" }));
    return screen.findByRole("dialog", { name: "New to-do" });
  }
  async function openEditDialog(title: string) {
    await openList();
    fireEvent.click(screen.getByRole("button", { name: `Edit: ${title}` }));
    return screen.findByRole("dialog", { name: "Edit to-do" });
  }
  const set = (dialog: HTMLElement, label: string, value: string) =>
    fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });

  it("marks only a repeating row, with a label that says how often", async () => {
    mount({ todos: withFilter });
    await openList();
    expect(
      within(rowOf("Change the filter")).getByRole("img", { name: "Repeats every 2 weeks" })
    ).toBeVisible();
    expect(within(rowOf("Call the plumber")).queryByRole("img")).not.toBeInTheDocument();
    expect(within(rowOf("Fix the tap")).queryByRole("img")).not.toBeInTheDocument();
  });

  it("labels a repeating row in Spanish, singular for an interval of one", async () => {
    mount({
      language: "es",
      todos: [
        ...withFilter,
        {
          ...filter,
          id: "boiler",
          title: "Revisar la caldera",
          repeat: { every: 1, unit: "year" },
        },
      ],
    });
    await screen.findByRole("list", { name: "Pendientes abiertos" });
    expect(
      within(rowOf("Change the filter")).getByRole("img", { name: "Se repite cada 2 semanas" })
    ).toBeVisible();
    expect(
      within(rowOf("Revisar la caldera")).getByRole("img", { name: "Se repite cada año" })
    ).toBeVisible();
  });

  it("offers the repeat control only once a due date is set", async () => {
    mount();
    const dialog = await openCreateDialog();
    const repeats = within(dialog).getByLabelText("Repeats");
    expect(repeats).toBeDisabled();
    expect(repeats).toHaveValue("");
    expect(repeats).toHaveAccessibleDescription("Set a due date to make it repeat.");
    expect(within(dialog).queryByLabelText("Every")).not.toBeInTheDocument();

    set(dialog, "Due date", "2026-09-30");
    expect(repeats).toBeEnabled();
    expect(repeats).not.toHaveAccessibleDescription();
    expect(
      within(repeats)
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(["Never", "Days", "Weeks", "Months", "Years"]);
  });

  it("adds a to-do that repeats every 2 weeks and shows it marked", async () => {
    const backend = mount();
    const dialog = await openCreateDialog();
    set(dialog, "Title", "Change the filter");
    set(dialog, "Due date", "2026-09-30");
    set(dialog, "Repeats", "week");
    expect(within(dialog).getByLabelText("Every")).toHaveValue(1);
    expect(within(dialog).getByText("Repeats every week")).toBeVisible();
    set(dialog, "Every", "2");
    expect(within(dialog).getByText("Repeats every 2 weeks")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.bodies("POST /api/todos")).toEqual([
      {
        listId: "home",
        title: "Change the filter",
        dueDate: "2026-09-30",
        repeat: { every: 2, unit: "week" },
      },
    ]);
    expect(
      within(rowOf("Change the filter")).getByRole("img", { name: "Repeats every 2 weeks" })
    ).toBeVisible();
  });

  it.each([
    ["empty", ""],
    ["zero", "0"],
    ["100", "100"],
    ["a fraction", "1.5"],
  ])("refuses an interval that is %s and sends nothing", async (_label, value) => {
    const backend = mount();
    const dialog = await openCreateDialog();
    set(dialog, "Title", "Change the filter");
    set(dialog, "Due date", "2026-09-30");
    set(dialog, "Repeats", "month");
    set(dialog, "Every", value);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Enter a whole number from 1 to 99."
    );
    expect(within(dialog).getByLabelText("Every")).toBeInvalid();
    expect(backend.keys("POST")).toEqual([]);

    set(dialog, "Every", "99");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.bodies("POST /api/todos")).toMatchObject([
      { repeat: { every: 99, unit: "month" } },
    ]);
  });

  it("sends no rule when the due date is taken away again before saving", async () => {
    const backend = mount();
    const dialog = await openCreateDialog();
    set(dialog, "Title", "Change the filter");
    set(dialog, "Due date", "2026-09-30");
    set(dialog, "Repeats", "day");
    set(dialog, "Due date", "");
    expect(within(dialog).getByLabelText("Repeats")).toBeDisabled();
    expect(within(dialog).queryByLabelText("Every")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.bodies("POST /api/todos")).toEqual([
      { listId: "home", title: "Change the filter" },
    ]);
  });

  it("shows the stored rule and sends it only when it changed", async () => {
    const backend = mount({ todos: withFilter });
    const unchanged = await openEditDialog("Change the filter");
    expect(within(unchanged).getByLabelText("Repeats")).toHaveValue("week");
    expect(within(unchanged).getByLabelText("Every")).toHaveValue(2);
    fireEvent.click(within(unchanged).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.keys("PATCH")).toEqual([]);

    const dialog = await openEditDialog("Change the filter");
    set(dialog, "Every", "3");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.bodies("PATCH /api/todos/filter")).toEqual([
      { repeat: { every: 3, unit: "week" } },
    ]);
    expect(
      await within(rowOf("Change the filter")).findByRole("img", { name: "Repeats every 3 weeks" })
    ).toBeVisible();
  });

  it("stops a to-do from repeating", async () => {
    const backend = mount({ todos: withFilter });
    const dialog = await openEditDialog("Change the filter");
    set(dialog, "Repeats", "");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.bodies("PATCH /api/todos/filter")).toEqual([{ repeat: null }]);
    await waitFor(() =>
      expect(within(rowOf("Change the filter")).queryByRole("img")).not.toBeInTheDocument()
    );
  });

  it("clears the rule together with the due date of a repeating to-do", async () => {
    const backend = mount({ todos: withFilter });
    const dialog = await openEditDialog("Change the filter");
    set(dialog, "Due date", "");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.bodies("PATCH /api/todos/filter")).toEqual([{ dueDate: null, repeat: null }]);
    expect(backend.todo("filter")).toMatchObject({ dueDate: null, repeat: null });
  });

  it("gives an existing to-do a rule", async () => {
    const backend = mount();
    const dialog = await openEditDialog("Book the van");
    set(dialog, "Repeats", "year");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.bodies("PATCH /api/todos/future")).toEqual([
      { repeat: { every: 1, unit: "year" } },
    ]);
  });

  it("shows the next occurrence in the open list after a repeating to-do is completed", async () => {
    const backend = mount({ todos: withFilter });
    await openList();
    fireEvent.click(within(rowOf("Change the filter")).getByRole("checkbox"));

    // The completed one leaves and its copy for 6 October takes its place, still assigned.
    await waitFor(() =>
      expect(rowOf("Change the filter").querySelector("time")).toHaveAttribute(
        "datetime",
        "2026-10-06"
      )
    );
    const next = rowOf("Change the filter");
    expect(within(next).getByRole("checkbox")).not.toBeChecked();
    expect(within(next).getByRole("img", { name: "Repeats every 2 weeks" })).toBeVisible();
    expect(within(next).getByTestId("todo-assignee")).toHaveTextContent("Dana");
    expect(screen.getByRole("radio", { name: "Casa (5)" })).toBeChecked();
    expect(backend.todo("filter")?.completedAt).toBe(NOW);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    const done = await screen.findByRole("list", { name: "Done to-dos" });
    expect(titles(done)).toEqual(["Change the filter", "Pay the deposit"]);
    expect(within(done).getByRole("img", { name: "Repeats every 2 weeks" })).toBeVisible();
  });

  it("creates no second occurrence when the completed to-do is reopened and completed again", async () => {
    const backend = mount({ todos: [filter] });
    await openList();
    fireEvent.click(screen.getByRole("checkbox", { name: "Change the filter" }));
    await waitFor(() =>
      expect(rowOf("Change the filter").querySelector("time")).toHaveAttribute(
        "datetime",
        "2026-10-06"
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    const done = await screen.findByRole("list", { name: "Done to-dos" });
    fireEvent.click(within(done).getByRole("checkbox", { name: "Change the filter" }));
    await waitFor(() =>
      expect(titles(screen.getByRole("list", { name: "Open to-dos" }))).toHaveLength(2)
    );

    const open = screen.getByRole("list", { name: "Open to-dos" });
    fireEvent.click(within(open).getAllByRole("checkbox", { name: "Change the filter" })[0]);
    await waitFor(() =>
      expect(titles(screen.getByRole("list", { name: "Open to-dos" }))).toHaveLength(1)
    );
    expect(backend.todos.size).toBe(2);
  });
});

describe("TodosBoard loading and failures", () => {
  it("announces loading before the lists arrive", async () => {
    mount();
    expect(screen.getByRole("status")).toHaveTextContent("Loading to-dos…");
    await openList();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports a failed load without raw diagnostics and recovers on retry", async () => {
    let failing = true;
    mount({
      intercept: (key) =>
        failing && key === "GET /api/todos/lists"
          ? json({ error: "internal_error", message: "private diagnostic" }, 500)
          : undefined,
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("To-dos could not be loaded.");
    expect(screen.queryByText("private diagnostic")).not.toBeInTheDocument();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await openList()).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports a failed read of the selected list and retries only that read", async () => {
    let failing = true;
    const backend = mount({
      intercept: (key) =>
        failing && key.startsWith("GET /api/todos?") ? json({ error: "internal" }, 500) : undefined,
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("To-dos could not be loaded.");
    expect(screen.getByRole("radio", { name: "Casa (4)" })).toBeChecked();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await openList()).toBeVisible();
    expect(backend.keys("GET /api/todos/lists")).toHaveLength(1);
  });

  it("reports a failed Members read and recovers on retry", async () => {
    let failing = true;
    mount({
      intercept: (key) =>
        failing && key === "GET /api/members?lifecycle=all"
          ? json({ error: "internal" }, 500)
          : undefined,
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("To-dos could not be loaded.");
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(within(rowOf("Call the plumber")).getByTestId("todo-assignee")).toHaveTextContent(
      "Blair"
    );
  });

  it("reports a request that never reached the server", async () => {
    mount({
      intercept: (key) => {
        if (key === "GET /api/todos/lists") throw new TypeError("Failed to fetch");
        return undefined;
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("To-dos could not be loaded.");
  });

  it("keeps the list on screen when a slower read of the list left behind answers late", async () => {
    let release!: () => void;
    const slow = new Promise<void>((done) => {
      release = done;
    });
    mount({
      intercept: async (key) => {
        if (key === "GET /api/todos?listId=move&status=open") await slow;
        return undefined;
      },
    });
    await openList();
    fireEvent.click(screen.getByRole("radio", { name: "Mudanza de casa (1)" }));
    fireEvent.click(screen.getByRole("radio", { name: "Casa (4)" }));
    expect(await screen.findByRole("checkbox", { name: "Fix the tap" })).toBeVisible();
    await act(async () => release());
    expect(screen.getByRole("checkbox", { name: "Fix the tap" })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "Buy boxes" })).not.toBeInTheDocument();
  });

  it("ignores the failure of a read of the list left behind", async () => {
    const slow = held();
    mount({
      intercept: async (key) => {
        if (key !== "GET /api/todos?listId=move&status=open") return undefined;
        await slow.gate;
        return json({ error: "internal_error" }, 500);
      },
    });
    await openList();
    fireEvent.click(screen.getByRole("radio", { name: "Mudanza de casa (1)" }));
    fireEvent.click(screen.getByRole("radio", { name: "Casa (4)" }));
    expect(await screen.findByRole("checkbox", { name: "Fix the tap" })).toBeVisible();
    await slow.release();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Fix the tap" })).toBeVisible();
  });

  it("shows due dates without overdue marks until the household timezone is known", async () => {
    const settings = held();
    mount({
      intercept: async (key) => {
        if (key === "GET /api/settings") await settings.gate;
        return undefined;
      },
    });
    await openList();
    const row = rowOf("Renew passport");
    expect(row.querySelector("time")).toHaveTextContent("Fri, Sep 18");
    expect(within(row).queryByText("Overdue")).not.toBeInTheDocument();
    await settings.release();
    expect(await within(rowOf("Renew passport")).findByText("Overdue")).toBeVisible();
  });

  it("stays usable when the plugin answers 503 plugin_unavailable", async () => {
    const plugins: TodosBackendOptions["plugins"] = { todos: "inactive" };
    mount({ plugins });
    expect(await screen.findByRole("alert")).toHaveTextContent("To-dos are turned off.");
    expect(screen.queryByText("This plugin is unavailable.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "To-dos" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();

    plugins.todos = "active";
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await openList()).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says to-dos are turned off when a write meets the deactivated plugin", async () => {
    const plugins: TodosBackendOptions["plugins"] = {};
    mount({ plugins });
    await openList();
    plugins.todos = "inactive";
    fireEvent.click(screen.getByRole("checkbox", { name: "Fix the tap" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("To-dos are turned off.");
    expect(screen.getByRole("checkbox", { name: "Fix the tap" })).not.toBeChecked();
  });

  it("names everything Pendientes in Spanish and formats dates in Spanish", async () => {
    mount({ language: "es" });
    expect(await screen.findByRole("heading", { level: 1, name: "Pendientes" })).toBeVisible();
    await screen.findByRole("list", { name: "Pendientes abiertos" });
    const overdue = rowOf("Renew passport");
    expect(within(overdue).getByText("Vencido")).toBeVisible();
    expect(overdue.querySelector("time")).toHaveTextContent("vie, 18 sept");
    expect(screen.getByRole("button", { name: "Hechos" })).toBeVisible();
    expect(document.body).not.toHaveTextContent(/Tareas|Tasks/);
  });
});
