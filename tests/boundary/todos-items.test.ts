import { describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import type { Todo } from "../../src/shared";
import { useIsolatedDb } from "../helpers/db";
import { seedDeviceKey, seedMember, todosClient, withApp } from "../helpers/todos";

describe("todos items — create and read", () => {
  useIsolatedDb();

  it("POST with only listId and title creates an open, undated, unassigned to-do", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");

      const response = await client.call("POST", "/api/todos", {
        listId: list.id,
        title: "  Fix the tap  ",
      });

      expect(response.statusCode).toBe(201);
      const todo = response.json<Todo>();
      expect(todo).toEqual({
        id: expect.any(String),
        listId: list.id,
        title: "Fix the tap",
        notes: null,
        dueDate: null,
        assigneeMemberId: null,
        repeat: null,
        completedAt: null,
        createdAt: expect.any(Number),
        updatedAt: todo.createdAt,
      });
      expect(Number.isInteger(todo.createdAt)).toBe(true);
    });
  });

  it("POST stores every optional field and GET returns the same to-do", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");
      const assigneeMemberId = seedMember("parent");

      const created = await client.createTodo({
        listId: list.id,
        title: "Call the plumber",
        notes: "Ask for a quote first",
        dueDate: "2026-12-01",
        assigneeMemberId,
      });
      const read = await client.call("GET", `/api/todos/${created.id}`);

      expect(created).toMatchObject({
        notes: "Ask for a quote first",
        dueDate: "2026-12-01",
        assigneeMemberId,
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual(created);
    });
  });

  it("POST treats blank notes as no notes", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");
      const todo = await client.createTodo({ listId: list.id, title: "Fix the tap", notes: "  " });
      expect(todo.notes).toBeNull();
    });
  });

  it.each([
    ["a missing listId", { title: "Fix the tap" }],
    ["an unknown listId", { listId: "missing", title: "Fix the tap" }],
    ["a non-string listId", { listId: 4, title: "Fix the tap" }],
    ["a missing title", { listId: "LIST" }],
    ["a blank title", { listId: "LIST", title: " \n " }],
    ["a title of only zero-width characters", { listId: "LIST", title: "\u200B\u200D\u2060" }],
    ["a title of only direction marks and spaces", { listId: "LIST", title: " \u200E \u200F " }],
    ["a title of only a soft hyphen", { listId: "LIST", title: "\u00AD" }],
    ["a title of only a variation selector", { listId: "LIST", title: "\uFE0F" }],
    ["a non-string title", { listId: "LIST", title: 12 }],
    ["a title over 200 characters", { listId: "LIST", title: "x".repeat(201) }],
    ["non-string notes", { listId: "LIST", title: "Fix the tap", notes: 1 }],
    [
      "notes over 2000 characters",
      { listId: "LIST", title: "Fix the tap", notes: "x".repeat(2001) },
    ],
    ["a loosely formatted due date", { listId: "LIST", title: "Fix the tap", dueDate: "2026-2-3" }],
    ["an impossible due date", { listId: "LIST", title: "Fix the tap", dueDate: "2026-02-30" }],
    ["a timestamp as due date", { listId: "LIST", title: "Fix the tap", dueDate: 1764547200000 }],
    ["an unknown field", { listId: "LIST", title: "Fix the tap", priority: "high" }],
    ["a client-supplied completedAt", { listId: "LIST", title: "Fix the tap", completedAt: 1 }],
  ])("POST with %s -> 400 and nothing is stored", async (_label, payload) => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");
      const body =
        "listId" in payload && payload.listId === "LIST"
          ? { ...payload, listId: list.id }
          : payload;

      const response = await client.call("POST", "/api/todos", body);

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe("validation_error");
      expect(getDb().prepare("SELECT COUNT(*) AS count FROM todo_items").get()).toEqual({
        count: 0,
      });
    });
  });

  it("accepts a 200-character title and 2000-character notes", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");
      const response = await client.call("POST", "/api/todos", {
        listId: list.id,
        title: "x".repeat(200),
        notes: "y".repeat(2000),
      });
      expect(response.statusCode).toBe(201);
    });
  });

  it("caps a title after trimming: 200 characters padded with spaces are stored, 201 are not", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");

      const padded = await client.call("POST", "/api/todos", {
        listId: list.id,
        title: `   ${"x".repeat(200)}\n\t `,
      });
      expect(padded.statusCode).toBe(201);
      expect(padded.json<Todo>().title).toBe("x".repeat(200));

      const tooLong = await client.call("POST", "/api/todos", {
        listId: list.id,
        title: ` ${"x".repeat(201)} `,
      });
      expect(tooLong.statusCode).toBe(400);

      const id = padded.json<Todo>().id;
      const edited = await client.call("PATCH", `/api/todos/${id}`, {
        title: `  ${"y".repeat(200)}  `,
      });
      expect(edited.statusCode).toBe(200);
      expect(edited.json<Todo>().title).toBe("y".repeat(200));
      expect(
        (await client.call("PATCH", `/api/todos/${id}`, { title: ` ${"y".repeat(201)} ` }))
          .statusCode
      ).toBe(400);
    });
  });

  it("keeps a title whose visible text carries zero-width or format characters", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");
      for (const title of ["a\u200Bb", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "\u200Eשלום"]) {
        expect((await client.createTodo({ listId: list.id, title })).title).toBe(title);
      }
    });
  });

  it("GET, PATCH, DELETE and completion of an unknown to-do -> 404", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const responses = await Promise.all([
        client.call("GET", "/api/todos/missing"),
        client.call("PATCH", "/api/todos/missing", { title: "Fix the tap" }),
        client.call("DELETE", "/api/todos/missing"),
        client.call("POST", "/api/todos/missing/completion"),
        client.call("DELETE", "/api/todos/missing/completion"),
      ]);

      for (const response of responses) {
        expect(response.statusCode).toBe(404);
        expect(response.json<{ error: string }>().error).toBe("not_found");
      }
    });
  });
});

describe("todos items — edit and delete", () => {
  useIsolatedDb();

  it("PATCH changes only the fields it names and advances updatedAt", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const home = await client.createList("Home");
      const car = await client.createList("Car");
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-11-23T10:00:00.000Z"));
        const todo = await client.createTodo({
          listId: home.id,
          title: "Change the tyres",
          notes: "Winter set is in the garage",
          dueDate: "2026-12-01",
        });

        const response = await client.call("PATCH", `/api/todos/${todo.id}`, {
          listId: car.id,
          title: " Change the winter tyres ",
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          ...todo,
          listId: car.id,
          title: "Change the winter tyres",
          updatedAt: todo.updatedAt + 1,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("PATCH with null clears notes, due date and assignee", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");
      const todo = await client.createTodo({
        listId: list.id,
        title: "Call the plumber",
        notes: "Ask for a quote first",
        dueDate: "2026-12-01",
        assigneeMemberId: seedMember("parent"),
      });

      const response = await client.call("PATCH", `/api/todos/${todo.id}`, {
        notes: null,
        dueDate: null,
        assigneeMemberId: null,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        title: "Call the plumber",
        notes: null,
        dueDate: null,
        assigneeMemberId: null,
      });
    });
  });

  it("PATCH does not change whether a to-do is done", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");
      const todo = await client.createTodo({ listId: list.id, title: "Fix the tap" });
      const completed = (
        await client.call("POST", `/api/todos/${todo.id}/completion`)
      ).json<Todo>();

      const response = await client.call("PATCH", `/api/todos/${todo.id}`, { title: "Fix taps" });

      expect(response.json<Todo>().completedAt).toBe(completed.completedAt);
    });
  });

  it.each([
    ["an empty body", {}],
    ["a null title", { title: null }],
    ["a blank title", { title: "  " }],
    ["a title of only zero-width characters", { title: "\u200B\uFEFF" }],
    ["a null listId", { listId: null }],
    ["an unknown listId", { listId: "missing" }],
    ["an impossible due date", { dueDate: "2026-13-01" }],
    ["notes over 2000 characters", { notes: "x".repeat(2001) }],
    ["an unknown field", { title: "Fix taps", done: true }],
    ["a client-supplied completedAt", { completedAt: null }],
  ])("PATCH with %s -> 400 and the to-do is unchanged", async (_label, payload) => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");
      const todo = await client.createTodo({ listId: list.id, title: "Fix the tap" });

      const response = await client.call("PATCH", `/api/todos/${todo.id}`, payload);

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe("validation_error");
      expect((await client.call("GET", `/api/todos/${todo.id}`)).json()).toEqual(todo);
    });
  });

  it("DELETE removes the to-do and keeps its list", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");
      const todo = await client.createTodo({ listId: list.id, title: "Fix the tap" });

      const response = await client.call("DELETE", `/api/todos/${todo.id}`);

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect((await client.call("GET", `/api/todos/${todo.id}`)).statusCode).toBe(404);
      expect(getDb().prepare("SELECT id FROM todo_lists").all()).toEqual([{ id: list.id }]);
    });
  });
});

describe("todos items — completion", () => {
  useIsolatedDb();

  it("completing twice keeps the first completedAt; reopening twice leaves it open", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-11-23T10:00:00.000Z"));
        const todo = await client.createTodo({ listId: list.id, title: "Fix the tap" });

        vi.setSystemTime(new Date("2026-11-24T08:30:00.000Z"));
        const first = await client.call("POST", `/api/todos/${todo.id}/completion`);
        vi.setSystemTime(new Date("2026-11-25T08:30:00.000Z"));
        const second = await client.call("POST", `/api/todos/${todo.id}/completion`);

        expect(first.statusCode).toBe(200);
        expect(first.json()).toEqual({
          ...todo,
          completedAt: Date.parse("2026-11-24T08:30:00.000Z"),
          updatedAt: Date.parse("2026-11-24T08:30:00.000Z"),
          nextOccurrence: null,
        });
        expect(second.statusCode).toBe(200);
        expect(second.json()).toEqual(first.json());

        const reopened = await client.call("DELETE", `/api/todos/${todo.id}/completion`);
        vi.setSystemTime(new Date("2026-11-26T08:30:00.000Z"));
        const reopenedAgain = await client.call("DELETE", `/api/todos/${todo.id}/completion`);

        expect(reopened.statusCode).toBe(200);
        expect(reopened.json()).toEqual({
          ...todo,
          completedAt: null,
          updatedAt: Date.parse("2026-11-25T08:30:00.000Z"),
        });
        expect(reopenedAgain.statusCode).toBe(200);
        expect(reopenedAgain.json()).toEqual(reopened.json());
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("todos items — list, filter and order", () => {
  useIsolatedDb();

  async function seedBoard(client: ReturnType<typeof todosClient>) {
    const home = await client.createList("Home");
    const car = await client.createList("Car");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const create = async (minute: number, body: Record<string, unknown>) => {
        vi.setSystemTime(new Date(Date.UTC(2026, 10, 23, 10, minute)));
        return client.createTodo(body);
      };
      const undatedOld = await create(1, { listId: home.id, title: "undated old" });
      const dueLate = await create(2, {
        listId: home.id,
        title: "due late",
        dueDate: "2026-12-20",
      });
      const dueEarly = await create(3, {
        listId: car.id,
        title: "due early",
        dueDate: "2026-11-01",
      });
      const dueLateNewer = await create(4, {
        listId: car.id,
        title: "due late, newer",
        dueDate: "2026-12-20",
      });
      const undatedNew = await create(5, { listId: car.id, title: "undated new" });
      const doneDated = await create(6, { listId: home.id, title: "done", dueDate: "2026-10-01" });
      const doneUndated = await create(7, { listId: home.id, title: "done undated" });
      await client.call("POST", `/api/todos/${doneUndated.id}/completion`);
      await client.call("POST", `/api/todos/${doneDated.id}/completion`);
      return {
        home,
        car,
        undatedOld,
        dueLate,
        dueEarly,
        dueLateNewer,
        undatedNew,
        doneDated,
        doneUndated,
      };
    } finally {
      vi.useRealTimers();
    }
  }

  const titles = (todos: Todo[]) => todos.map((todo) => todo.title);

  it("defaults to open to-dos: due date ascending, undated last, then creation order", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      await seedBoard(client);

      const expected = ["due early", "due late", "due late, newer", "undated old", "undated new"];
      expect(titles(await client.listTodos())).toEqual(expected);
      expect(titles(await client.listTodos("?status=open"))).toEqual(expected);
    });
  });

  it("status=done returns only done to-dos and status=all puts open ones first", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      await seedBoard(client);

      expect(titles(await client.listTodos("?status=done"))).toEqual(["done", "done undated"]);
      expect(titles(await client.listTodos("?status=all"))).toEqual([
        "due early",
        "due late",
        "due late, newer",
        "undated old",
        "undated new",
        "done",
        "done undated",
      ]);
    });
  });

  it("listId keeps one list's to-dos; an unknown list has none", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const { car } = await seedBoard(client);

      expect(titles(await client.listTodos(`?listId=${car.id}`))).toEqual([
        "due early",
        "due late, newer",
        "undated new",
      ]);
      expect(await client.listTodos("?listId=missing")).toEqual([]);
    });
  });

  it("dueBy keeps to-dos due on or before the date, overdue included, and drops undated ones", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      await seedBoard(client);

      expect(titles(await client.listTodos("?dueBy=2026-12-20"))).toEqual([
        "due early",
        "due late",
        "due late, newer",
      ]);
      expect(titles(await client.listTodos("?dueBy=2026-12-19"))).toEqual(["due early"]);
      expect(titles(await client.listTodos("?dueBy=2026-12-19&status=all"))).toEqual([
        "due early",
        "done",
      ]);
    });
  });

  it("filters combine", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const { home } = await seedBoard(client);

      expect(
        titles(await client.listTodos(`?listId=${home.id}&dueBy=2026-12-31&status=all`))
      ).toEqual(["due late", "done"]);
    });
  });

  it.each([
    ["an unknown status", "?status=pending"],
    ["a loosely formatted dueBy", "?dueBy=2026-12-1"],
    ["an impossible dueBy", "?dueBy=2026-02-30"],
    ["a repeated status", "?status=open&status=done"],
    ["a repeated listId", "?listId=a&listId=b"],
    ["a repeated assigneeMemberId", "?assigneeMemberId=a&assigneeMemberId=b"],
  ])("GET with %s -> 400", async (_label, query) => {
    await withApp(async (app) => {
      const response = await todosClient(app, seedDeviceKey()).call("GET", `/api/todos${query}`);
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe("validation_error");
    });
  });
});
