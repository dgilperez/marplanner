import { test, expect, type Page } from "@playwright/test";
import { messages, resolveLang } from "../../src/client/i18n/messages";
import { PLUGIN_UNAVAILABLE_RESPONSE } from "../../src/shared";
import { DEFAULT_ADMIN_PIN } from "./admin-unlock";
import { startFreshPluginLifecycleServer } from "./plugin-lifecycle-server";

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN ?? "mpg-e2e-access-token";
const BOOTSTRAP_KEY = process.env.MP_BOOTSTRAP_KEY ?? "mpk-e2e-bootstrap-key";

function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

/** Passes the access gate and provisions the device, then reads the household's copy. */
async function provision(page: Page, origin = "") {
  await page.goto(`${origin}/`);
  await page.getByTestId("access-gate-form").locator('input[name="token"]').fill(ACCESS_TOKEN);
  await page.getByRole("button", { name: "Enter" }).click();
  await page.getByLabel("Bootstrap key").fill(BOOTSTRAP_KEY);
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible({ timeout: 15_000 });

  const response = await page.request.get(`${origin}/api/settings`);
  expect(response.status()).toBe(200);
  const settings = (await response.json()) as { locale: { language?: string; timezone: string } };
  return {
    m: messages[resolveLang(settings.locale.language)],
    today: todayInTimezone(settings.locale.timezone),
  };
}

async function enterAdminPin(page: Page, pin: string) {
  await expect(page.getByTestId("admin-pin-keypad")).toBeVisible();
  for (const digit of pin) await page.getByTestId(`admin-pin-digit-${digit}`).click();
}

let createdListIds: string[] = [];
let createdMemberIds: string[] = [];

test.beforeEach(() => {
  createdListIds = [];
  createdMemberIds = [];
});

test.afterEach(async ({ page }) => {
  // A list the test already deleted answers 404; deleting a list removes its to-dos.
  for (const listId of createdListIds) {
    expect([204, 404]).toContain(
      (await page.request.delete(`/api/todos/lists/${listId}`)).status()
    );
  }
  for (const memberId of createdMemberIds) {
    await page.request.post(`/api/members/${memberId}/archive`);
  }
});

test("adults keep a to-do list on the kiosk and complete from the Home agenda", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const listName = `Paperwork ${suffix}`;
  const quickTitle = `Renew passport ${suffix}`;
  const dueTitle = `Call the plumber ${suffix}`;
  const adultName = `Adult ${suffix}`;

  const { m, today } = await provision(page);
  const memberResponse = await page.request.post("/api/members", {
    data: { displayName: adultName, role: "parent" },
  });
  expect(memberResponse.status()).toBe(201);
  createdMemberIds.push(((await memberResponse.json()) as { id: string }).id);

  await page.goto("/todos");
  await expect(page.getByTestId("todos-board")).toBeVisible({ timeout: 15_000 });

  // Create a list: the page offers "Create the first list" until one exists.
  await page
    .getByRole("button", { name: m["todos.lists.createFirst"] })
    .or(page.getByRole("button", { name: m["todos.lists.new"], exact: true }))
    .click();
  await page.getByLabel(m["todos.lists.nameLabel"]).fill(listName);
  const listCreated = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/todos/lists") && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: m["todos.action.save"] }).click();
  const listResponse = await listCreated;
  expect(listResponse.status()).toBe(201);
  const listId = ((await listResponse.json()) as { id: string }).id;
  createdListIds.push(listId);
  await expect(page.getByRole("heading", { level: 2, name: listName })).toBeVisible();
  await expect(page.getByTestId(`todos-list-${listId}`)).toBeChecked();

  // Quick add.
  const openList = page.getByRole("list", { name: m["todos.items.openLabel"] });
  await page.getByRole("textbox", { name: m["todos.quickAdd.label"] }).fill(quickTitle);
  await page.getByRole("textbox", { name: m["todos.quickAdd.label"] }).press("Enter");
  await expect(openList.getByRole("checkbox", { name: quickTitle })).toBeVisible();
  await expect(page.getByRole("textbox", { name: m["todos.quickAdd.label"] })).toHaveValue("");

  // Add with a due date and an adult assignee.
  await page.getByRole("button", { name: m["todos.quickAdd.details"] }).click();
  const todoDialog = page.getByRole("dialog", { name: m["todos.dialog.createTitle"] });
  await todoDialog.getByLabel(m["todos.field.title"]).fill(dueTitle);
  await todoDialog.getByLabel(m["todos.field.dueDate"]).fill(today);
  await todoDialog.getByRole("checkbox", { name: adultName }).check({ timeout: 10_000 });
  await expect(todoDialog.getByRole("checkbox", { name: adultName })).toBeChecked();
  await todoDialog.getByRole("button", { name: m["todos.quickAdd.submit"], exact: true }).click();
  await expect(todoDialog).toBeHidden();
  const dueRow = openList.getByRole("listitem").filter({ hasText: dueTitle });
  await expect(dueRow.getByTestId("todo-assignee")).toHaveText(adultName);
  await expect(dueRow.locator("time")).toHaveAttribute("datetime", today);

  // Home lists the to-do due today in the agenda's To-dos group, not the undated one.
  await page.goto("/");
  const agendaGroup = page.getByRole("list", { name: m["todos.title"], exact: true });
  await expect(agendaGroup.getByRole("checkbox", { name: dueTitle })).toBeVisible({
    timeout: 15_000,
  });
  await expect(agendaGroup.getByRole("checkbox", { name: quickTitle })).toHaveCount(0);
  const completed = page.waitForResponse(
    (response) => response.url().endsWith("/completion") && response.request().method() === "POST"
  );
  await agendaGroup.getByRole("checkbox", { name: dueTitle }).click();
  expect((await completed).status()).toBe(200);
  await expect(page.getByRole("checkbox", { name: dueTitle })).toHaveCount(0);

  // The page shows it under Done, and unchecking it there reopens it.
  await page.goto("/todos");
  await page.getByTestId(`todos-list-${listId}`).check({ force: true });
  await expect(openList.getByRole("checkbox", { name: quickTitle })).toBeVisible();
  await expect(openList.getByRole("checkbox", { name: dueTitle })).toHaveCount(0);
  await page.getByRole("button", { name: m["todos.done.title"], exact: true }).click();
  const doneList = page.getByRole("list", { name: m["todos.done.listLabel"] });
  await expect(doneList.getByRole("checkbox", { name: dueTitle })).toBeChecked();
  await doneList.getByRole("checkbox", { name: dueTitle }).click();
  await expect(openList.getByRole("checkbox", { name: dueTitle })).not.toBeChecked();

  // Deleting the list asks for the admin PIN; nothing else on the page did.
  const deleteQuestion = page.getByRole("dialog", {
    name: m["todos.lists.deleteConfirm"].replace("{name}", () => listName),
  });
  await page.getByRole("button", { name: m["todos.lists.delete"] }).click();
  await enterAdminPin(page, "9999");
  await page.getByTestId("admin-pin-unlock").click();
  await expect(page.getByText("Incorrect PIN.")).toBeVisible();
  await expect(deleteQuestion).toHaveCount(0);
  await page.getByTestId("admin-pin-cancel").click();
  await expect(page.getByTestId("admin-pin-keypad")).toBeHidden();
  expect((await page.request.get(`/api/todos?listId=${listId}&status=all`)).status()).toBe(200);
  await expect(page.getByTestId(`todos-list-${listId}`)).toBeChecked();

  await page.getByRole("button", { name: m["todos.lists.delete"] }).click();
  await enterAdminPin(page, DEFAULT_ADMIN_PIN);
  await expect(deleteQuestion).toBeVisible();
  await expect(
    deleteQuestion.getByText(m["todos.lists.deleteMany"].replace("{count}", "2"))
  ).toBeVisible();
  await deleteQuestion.getByRole("button", { name: m["todos.action.delete"] }).click();
  await expect(page.getByTestId(`todos-list-${listId}`)).toHaveCount(0);
  const remaining = (await (await page.request.get("/api/todos/lists")).json()) as { id: string }[];
  expect(remaining.map((list) => list.id)).not.toContain(listId);
  expect(await (await page.request.get(`/api/todos?listId=${listId}&status=all`)).json()).toEqual(
    []
  );
});

test.describe("while the to-dos plugin is deactivated", () => {
  let server: Awaited<ReturnType<typeof startFreshPluginLifecycleServer>>;

  test.beforeAll(async () => {
    server = await startFreshPluginLifecycleServer();
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test("the open page says to-dos are turned off, then the page and its nav entry go away", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { origin } = server;
    const { m } = await provision(page, origin);
    const nav = page.getByTestId("household-nav");
    const navEntry = nav.getByRole("link", { name: m["shell.nav.todos"], exact: true });

    // A fresh installation has the plugin inactive.
    await expect(navEntry).toHaveCount(0);
    expect((await page.request.post(`${origin}/api/plugins/todos/activate`)).status()).toBe(200);
    expect(
      (await page.request.post(`${origin}/api/todos/lists`, { data: { name: "Home" } })).status()
    ).toBe(201);

    await page.goto(`${origin}/todos`);
    await expect(page.getByTestId("todos-board")).toBeVisible({ timeout: 15_000 });
    await expect(navEntry).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible();

    // Deactivated from elsewhere while this page is open: its next request meets the 503.
    expect((await page.request.post(`${origin}/api/plugins/todos/deactivate`)).status()).toBe(200);
    const gated = await page.request.get(`${origin}/api/todos/lists`);
    expect(gated.status()).toBe(503);
    expect(await gated.json()).toEqual(PLUGIN_UNAVAILABLE_RESPONSE);

    await page.getByRole("textbox", { name: m["todos.quickAdd.label"] }).fill("Fix the tap");
    await page.getByRole("textbox", { name: m["todos.quickAdd.label"] }).press("Enter");
    await expect(page.getByRole("alert")).toHaveText(m["todos.unavailable"]);
    await expect(page.getByText(PLUGIN_UNAVAILABLE_RESPONSE.message)).toHaveCount(0);

    // Once the page reads the catalog again, the route and the nav entry are withdrawn.
    await page.reload();
    await expect(page.getByTestId("plugin-unavailable")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("todos-board")).toHaveCount(0);
    await expect(nav).toBeVisible();
    await expect(navEntry).toHaveCount(0);
  });
});
