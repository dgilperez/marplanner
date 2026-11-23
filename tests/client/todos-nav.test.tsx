import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Shell } from "@/shell/Shell";
import { resolveHouseholdRoute } from "@/shell/routes";
import type { PluginId, PluginState } from "../../src/shared/plugins";
import { json } from "./helpers/fetchRoutes";
import { todosBackend } from "./helpers/todosBackend";

const OWN_READS = ["/api/todos", "/api/plugins", "/api/settings", "/api/members"];

function mount(
  path: string,
  plugins: Partial<Record<PluginId, PluginState>> = {},
  language: "en" | "es" = "en"
) {
  window.history.replaceState({}, "", path);
  const backend = todosBackend({
    lists: [{ id: "home", name: "Casa" }],
    todos: [{ id: "tap", listId: "home", title: "Fix the tap" }],
    plugins,
    language,
    // The other surfaces of the shell read their own endpoints; an empty answer keeps them quiet.
    other: (key) =>
      OWN_READS.some((path) => key.startsWith(`GET ${path}`)) ? undefined : json([]),
  });
  render(<Shell />);
  return backend;
}

async function navLinks(): Promise<(string | null)[][]> {
  await screen.findByTestId("plugin-health-indicator");
  const nav = screen.getByRole("navigation", { name: "Household navigation" });
  return within(nav)
    .getAllByRole("link")
    .map((link) => [link.textContent, link.getAttribute("href")]);
}

beforeEach(() => {
  document.cookie = "mp_provisioned=1; path=/";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = "mp_provisioned=; Max-Age=0; path=/";
  window.history.replaceState({}, "", "/");
});

describe("household navigation gated per plugin", () => {
  it("resolves /todos as a family destination owned by the todos plugin", () => {
    expect(resolveHouseholdRoute("/todos")).toMatchObject({
      kind: "family",
      id: "todos",
      pluginId: "todos",
      contributionGroup: "routes",
      contributionId: "todos-api",
    });
  });

  it("links To-dos after Meals while both plugins are active", async () => {
    mount("/calendar");
    expect(await navLinks()).toEqual([
      ["Home", "/"],
      ["Calendar", "/calendar"],
      ["Tasks", "/chores"],
      ["Meals", "/meals"],
      ["To-dos", "/todos"],
    ]);
  });

  it("hides only To-dos while the todos plugin is inactive", async () => {
    mount("/calendar", { todos: "inactive" });
    expect((await navLinks()).map(([label]) => label)).toEqual([
      "Home",
      "Calendar",
      "Tasks",
      "Meals",
    ]);
  });

  it("hides only Meals while the meals plugin is inactive", async () => {
    mount("/calendar", { "meals-recipes": "inactive" });
    expect((await navLinks()).map(([label]) => label)).toEqual([
      "Home",
      "Calendar",
      "Tasks",
      "To-dos",
    ]);
  });

  it("hides both plugin pages while both plugins are inactive", async () => {
    mount("/calendar", { todos: "inactive", "meals-recipes": "errored" });
    expect((await navLinks()).map(([label]) => label)).toEqual(["Home", "Calendar", "Tasks"]);
  });

  it("renders the To-dos page inside the household chrome at /todos", async () => {
    mount("/todos");
    expect(await screen.findByRole("heading", { level: 1, name: "To-dos" })).toBeVisible();
    expect(await screen.findByRole("checkbox", { name: "Fix the tap" })).toBeVisible();
    const nav = screen.getByRole("navigation", { name: "Household navigation" });
    expect(within(nav).getByRole("link", { name: "To-dos" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.queryByTestId("admin-pin-keypad")).not.toBeInTheDocument();
  });

  it("keeps the shell and shows the unavailable notice at /todos while the plugin is inactive", async () => {
    const backend = mount("/todos", { todos: "inactive" });
    expect(await screen.findByTestId("plugin-unavailable")).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Household navigation" })).toBeVisible();
    expect(screen.queryByRole("heading", { level: 1, name: "To-dos" })).not.toBeInTheDocument();
    expect(backend.keys("GET /api/todos")).toEqual([]);
  });

  it("names the page Pendientes in the Spanish navigation", async () => {
    mount("/calendar", {}, "es");
    await screen.findByTestId("plugin-health-indicator");
    const nav = await screen.findByRole("navigation", { name: "Navegación del hogar" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent)
    ).toEqual(["Inicio", "Calendario", "Tareas", "Comidas", "Pendientes"]);
  });
});
