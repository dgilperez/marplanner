import { describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import type { TodoList } from "../../src/shared";
import { useIsolatedDb } from "../helpers/db";
import { seedDeviceKey, todosClient, withApp } from "../helpers/todos";

describe("todos lists", () => {
  useIsolatedDb();

  it("POST creates a list with a trimmed name and no open to-dos", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const response = await client.call("POST", "/api/todos/lists", { name: "  Home  " });

      expect(response.statusCode).toBe(201);
      const list = response.json<TodoList>();
      expect(list).toEqual({
        id: expect.any(String),
        name: "Home",
        openCount: 0,
        createdAt: expect.any(Number),
        updatedAt: list.createdAt,
      });
      expect(Number.isInteger(list.createdAt)).toBe(true);
    });
  });

  it("GET orders lists by name, ignoring case, and counts only open to-dos", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const paperwork = await client.createList("paperwork");
      await client.createList("Home");
      await client.createList("car");
      await client.createTodo({ listId: paperwork.id, title: "Renew passport" });
      const done = await client.createTodo({ listId: paperwork.id, title: "File taxes" });
      await client.call("POST", `/api/todos/${done.id}/completion`);

      const response = await client.call("GET", "/api/todos/lists");

      expect(response.statusCode).toBe(200);
      expect(
        response.json<TodoList[]>().map(({ name, openCount }) => ({ name, openCount }))
      ).toEqual([
        { name: "car", openCount: 0 },
        { name: "Home", openCount: 0 },
        { name: "paperwork", openCount: 1 },
      ]);
    });
  });

  it.each([
    ["a missing name", {}],
    ["a non-string name", { name: 7 }],
    ["a blank name", { name: "   " }],
    ["a name of only zero-width characters", { name: "\u200B\u200C\u200D" }],
    ["a name of only direction marks and spaces", { name: " \u202A\u202C " }],
    ["a name over 80 characters", { name: "x".repeat(81) }],
    ["an unknown field", { name: "Home", color: "red" }],
  ])("POST with %s -> 400 and nothing is stored", async (_label, payload) => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const response = await client.call("POST", "/api/todos/lists", payload);

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe("validation_error");
      expect(getDb().prepare("SELECT COUNT(*) AS count FROM todo_lists").get()).toEqual({
        count: 0,
      });
    });
  });

  it.each([
    ["an array", "[]"],
    ["a string", '"Home"'],
    ["null", "null"],
  ])("POST with %s as the body -> 400", async (_label, body) => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/todos/lists",
        cookies: { mp_device_key: seedDeviceKey() },
        headers: { "content-type": "application/json" },
        payload: body,
      });
      expect(response.statusCode).toBe(400);
    });
  });

  it("accepts a name of exactly 80 characters", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const response = await client.call("POST", "/api/todos/lists", { name: "x".repeat(80) });
      expect(response.statusCode).toBe(201);
    });
  });

  it("caps a name after trimming: 80 characters padded with spaces are stored, 81 are not", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());

      const padded = await client.call("POST", "/api/todos/lists", {
        name: `   ${"x".repeat(80)}\n `,
      });
      expect(padded.statusCode).toBe(201);
      expect(padded.json<TodoList>().name).toBe("x".repeat(80));
      expect(
        (await client.call("POST", "/api/todos/lists", { name: ` ${"y".repeat(81)} ` })).statusCode
      ).toBe(400);

      const url = `/api/todos/lists/${padded.json<TodoList>().id}`;
      const renamed = await client.call("PATCH", url, { name: `  ${"z".repeat(80)}  ` });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json<TodoList>().name).toBe("z".repeat(80));
      expect((await client.call("PATCH", url, { name: ` ${"z".repeat(81)} ` })).statusCode).toBe(
        400
      );
    });
  });

  it("POST with a name another list already has -> 409", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      await client.createList("Home");

      const response = await client.call("POST", "/api/todos/lists", { name: " Home " });

      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toBe("duplicate_name");
      expect(getDb().prepare("SELECT COUNT(*) AS count FROM todo_lists").get()).toEqual({
        count: 1,
      });
    });
  });

  it("PATCH renames a list and advances updatedAt", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-11-23T10:00:00.000Z"));
        const list = await client.createList("Home");

        // The clock is frozen, so the stored value itself has to move forward.
        const response = await client.call("PATCH", `/api/todos/lists/${list.id}`, {
          name: "House",
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          ...list,
          name: "House",
          updatedAt: list.updatedAt + 1,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("PATCH keeps the list's own name without a conflict", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");
      const response = await client.call("PATCH", `/api/todos/lists/${list.id}`, { name: "Home" });
      expect(response.statusCode).toBe(200);
    });
  });

  it("PATCH to another list's name -> 409 and the name is unchanged", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      await client.createList("Home");
      const car = await client.createList("Car");

      const response = await client.call("PATCH", `/api/todos/lists/${car.id}`, { name: "Home" });

      expect(response.statusCode).toBe(409);
      expect(getDb().prepare("SELECT name FROM todo_lists WHERE id = ?").get(car.id)).toEqual({
        name: "Car",
      });
    });
  });

  it.each([
    ["an empty body", {}],
    ["a blank name", { name: " " }],
    ["a name of only zero-width characters", { name: "\u200B" }],
    ["an unknown field", { name: "House", openCount: 3 }],
  ])("PATCH with %s -> 400", async (_label, payload) => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");
      const response = await client.call("PATCH", `/api/todos/lists/${list.id}`, payload);
      expect(response.statusCode).toBe(400);
    });
  });

  it("PATCH and DELETE of an unknown list -> 404", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const patched = await client.call("PATCH", "/api/todos/lists/missing", { name: "House" });
      const deleted = await client.call("DELETE", "/api/todos/lists/missing");

      expect(patched.statusCode).toBe(404);
      expect(patched.json<{ error: string }>().error).toBe("not_found");
      expect(deleted.statusCode).toBe(404);
    });
  });

  it("an unexpected storage failure answers 500 without leaking its cause", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        getDb().exec("DROP TABLE todo_items; DROP TABLE todo_lists;");

        const response = await client.call("POST", "/api/todos/lists", { name: "Home" });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({
          error: "internal_error",
          message: "An unexpected error occurred",
        });
        expect(logged).toHaveBeenCalledOnce();
      } finally {
        logged.mockRestore();
      }
    });
  });

  it("DELETE removes the list and its to-dos, and leaves other lists alone", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const home = await client.createList("Home");
      const car = await client.createList("Car");
      const doomed = await client.createTodo({ listId: home.id, title: "Fix the tap" });
      const kept = await client.createTodo({ listId: car.id, title: "Book the inspection" });

      const response = await client.call("DELETE", `/api/todos/lists/${home.id}`);

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect((await client.call("GET", `/api/todos/${doomed.id}`)).statusCode).toBe(404);
      expect(getDb().prepare("SELECT id FROM todo_items").all()).toEqual([{ id: kept.id }]);
      expect(getDb().prepare("SELECT id FROM todo_lists").all()).toEqual([{ id: car.id }]);
    });
  });
});
