import { describe, expect, it } from "vitest";
import { useIsolatedDb } from "../helpers/db";
import { seedDeviceKey, todosClient, withApp, withClock } from "../helpers/todos";
import { DUE_RANGE_CASES, DUE_RANGE_REFUSALS, DUE_RANGE_SEEDS } from "../helpers/todos-due-range";

describe("todos listing — due date range", () => {
  useIsolatedDb();

  /** Stores the shared seeds one minute apart, so creation order breaks a tie of due dates. */
  async function seeded(client: ReturnType<typeof todosClient>) {
    const list = await client.createList("Home");
    await withClock("2026-09-01T10:00:00.000Z", async (at) => {
      for (const [index, seed] of DUE_RANGE_SEEDS.entries()) {
        at(new Date(Date.UTC(2026, 8, 1, 10, index)).toISOString());
        const todo = await client.createTodo({
          listId: list.id,
          title: seed.title,
          dueDate: seed.dueDate,
        });
        if (seed.done) await client.call("POST", `/api/todos/${todo.id}/completion`);
      }
    });
  }

  it.each(DUE_RANGE_CASES)("%s", async (_label, query, expected) => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      await seeded(client);
      expect((await client.listTodos(query)).map((todo) => todo.title)).toEqual(expected);
    });
  });

  it.each(DUE_RANGE_REFUSALS)("GET with %s -> 400", async (_label, query) => {
    await withApp(async (app) => {
      const response = await todosClient(app, seedDeviceKey()).call("GET", `/api/todos${query}`);
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe("validation_error");
    });
  });
});
