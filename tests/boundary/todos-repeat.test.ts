import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import type { Todo, TodoCompletion } from "../../src/shared";
import { BASELINE_FILE, SHIPPED_MIGRATION_FILES, execBaseline } from "../helpers/baseline";
import { useIsolatedDb } from "../helpers/db";
import {
  archiveMember,
  seedDeviceKey,
  seedMember,
  setHouseholdTimezone,
  todosClient,
  withApp,
  withClock,
} from "../helpers/todos";

const MIGRATION = "0004_todo_repeat.sql";
const MONTHLY = { every: 1, unit: "month" };

/** A client with one list, the household on UTC, and a shorthand for completing. */
async function household(app: FastifyInstance) {
  setHouseholdTimezone("UTC");
  const client = todosClient(app, seedDeviceKey());
  const list = await client.createList("Home");
  return {
    ...client,
    list,
    add: (fields: Record<string, unknown>) =>
      client.createTodo({ listId: list.id, title: "Renew the car insurance", ...fields }),
    async complete(id: string): Promise<TodoCompletion> {
      const response = await client.call("POST", `/api/todos/${id}/completion`);
      if (response.statusCode !== 200) throw new Error(`complete failed: ${response.body}`);
      return response.json<TodoCompletion>();
    },
  };
}

const storedCount = () =>
  (getDb().prepare("SELECT COUNT(*) AS count FROM todo_items").get() as { count: number }).count;

describe("todos repeat — rule on create and edit", () => {
  useIsolatedDb();

  it("POST stores the rule and every read returns it; a to-do without one reads null", async () => {
    await withApp(async (app) => {
      const client = await household(app);

      const repeating = await client.add({
        dueDate: "2026-12-01",
        repeat: { every: 2, unit: "week" },
      });
      const once = await client.add({ title: "Call the plumber", dueDate: "2026-12-02" });

      expect(repeating.repeat).toEqual({ every: 2, unit: "week" });
      expect(once.repeat).toBeNull();
      expect((await client.call("GET", `/api/todos/${repeating.id}`)).json()).toEqual(repeating);
      expect((await client.listTodos()).map((todo) => todo.repeat)).toEqual([
        { every: 2, unit: "week" },
        null,
      ]);
    });
  });

  it.each([
    ["a rule without a due date", { repeat: MONTHLY }],
    ["a rule with a null due date", { dueDate: null, repeat: MONTHLY }],
    ["a string rule", { dueDate: "2026-12-01", repeat: "monthly" }],
    ["an unknown unit", { dueDate: "2026-12-01", repeat: { every: 1, unit: "hour" } }],
    ["a zero interval", { dueDate: "2026-12-01", repeat: { every: 0, unit: "day" } }],
    ["an interval of 100", { dueDate: "2026-12-01", repeat: { every: 100, unit: "day" } }],
    ["a fractional interval", { dueDate: "2026-12-01", repeat: { every: 1.5, unit: "day" } }],
    ["a rule missing its unit", { dueDate: "2026-12-01", repeat: { every: 1 } }],
    [
      "a rule with an extra field",
      { dueDate: "2026-12-01", repeat: { every: 1, unit: "day", count: 3 } },
    ],
    ["a client-supplied next occurrence", { dueDate: "2026-12-01", nextOccurrence: null }],
  ])("POST with %s -> 400 and nothing is stored", async (_label, fields) => {
    await withApp(async (app) => {
      const client = await household(app);

      const response = await client.call("POST", "/api/todos", {
        listId: client.list.id,
        title: "Renew the car insurance",
        ...fields,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe("validation_error");
      expect(storedCount()).toBe(0);
    });
  });

  it("accepts the shortest and the longest interval", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      const shortest = await client.add({
        dueDate: "2026-12-01",
        repeat: { every: 1, unit: "day" },
      });
      const longest = await client.add({
        dueDate: "2026-12-01",
        repeat: { every: 99, unit: "year" },
      });
      expect(shortest.repeat).toEqual({ every: 1, unit: "day" });
      expect(longest.repeat).toEqual({ every: 99, unit: "year" });
    });
  });

  it("PATCH sets, changes and clears the rule of a dated to-do", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      const todo = await client.add({ dueDate: "2026-12-01" });
      const patch = async (body: Record<string, unknown>) => {
        const response = await client.call("PATCH", `/api/todos/${todo.id}`, body);
        expect(response.statusCode).toBe(200);
        return response.json<Todo>();
      };

      expect((await patch({ repeat: MONTHLY })).repeat).toEqual(MONTHLY);
      expect((await patch({ title: "Pagar el seguro" })).repeat).toEqual(MONTHLY);
      expect((await patch({ repeat: { every: 3, unit: "year" } })).repeat).toEqual({
        every: 3,
        unit: "year",
      });
      expect((await patch({ repeat: null })).repeat).toBeNull();
      expect((await patch({ repeat: null })).dueDate).toBe("2026-12-01");
    });
  });

  it("PATCH gives an undated to-do a rule only together with a due date", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      const todo = await client.add({});

      const alone = await client.call("PATCH", `/api/todos/${todo.id}`, { repeat: MONTHLY });
      expect(alone.statusCode).toBe(400);
      expect(alone.json<{ error: string }>().error).toBe("validation_error");
      expect((await client.call("GET", `/api/todos/${todo.id}`)).json()).toEqual(todo);

      const together = await client.call("PATCH", `/api/todos/${todo.id}`, {
        dueDate: "2026-12-01",
        repeat: MONTHLY,
      });
      expect(together.statusCode).toBe(200);
      expect(together.json<Todo>()).toMatchObject({ dueDate: "2026-12-01", repeat: MONTHLY });
    });
  });

  it("PATCH clears the due date of a repeating to-do only when it clears the rule too", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      const todo = await client.add({ dueDate: "2026-12-01", repeat: MONTHLY });

      const dateOnly = await client.call("PATCH", `/api/todos/${todo.id}`, { dueDate: null });
      expect(dateOnly.statusCode).toBe(400);
      expect(dateOnly.json<{ error: string }>().error).toBe("validation_error");
      expect((await client.call("GET", `/api/todos/${todo.id}`)).json()).toEqual(todo);

      const both = await client.call("PATCH", `/api/todos/${todo.id}`, {
        dueDate: null,
        repeat: null,
      });
      expect(both.statusCode).toBe(200);
      expect(both.json<Todo>()).toMatchObject({ dueDate: null, repeat: null });
    });
  });

  it.each([
    ["an invalid rule", { repeat: { every: 0, unit: "day" } }],
    ["an anchor day", { repeatAnchorDay: 31 }],
    ["a next occurrence", { nextOccurrence: null }],
  ])("PATCH with %s -> 400 and the to-do is unchanged", async (_label, body) => {
    await withApp(async (app) => {
      const client = await household(app);
      const todo = await client.add({ dueDate: "2026-12-01", repeat: MONTHLY });

      const response = await client.call("PATCH", `/api/todos/${todo.id}`, body);

      expect(response.statusCode).toBe(400);
      expect((await client.call("GET", `/api/todos/${todo.id}`)).json()).toEqual(todo);
    });
  });
});

describe("todos repeat — completing creates the next occurrence", () => {
  useIsolatedDb();

  it("creates one open to-do with the same list, title, notes, assignee and rule", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      const assigneeMemberId = seedMember("parent");
      await withClock("2026-03-10T09:00:00.000Z", async (at) => {
        const todo = await client.add({
          notes: "Policy number on the fridge",
          dueDate: "2026-03-10",
          assigneeMemberId,
          repeat: { every: 2, unit: "week" },
        });

        at("2026-03-10T18:00:00.000Z");
        const completion = await client.complete(todo.id);

        const { nextOccurrence, ...completed } = completion;
        expect(completed).toEqual({
          ...todo,
          completedAt: Date.parse("2026-03-10T18:00:00.000Z"),
          updatedAt: Date.parse("2026-03-10T18:00:00.000Z"),
        });
        expect(nextOccurrence).toEqual({
          id: expect.any(String),
          listId: client.list.id,
          title: "Renew the car insurance",
          notes: "Policy number on the fridge",
          dueDate: "2026-03-24",
          assigneeMemberId,
          repeat: { every: 2, unit: "week" },
          completedAt: null,
          createdAt: Date.parse("2026-03-10T18:00:00.000Z"),
          updatedAt: Date.parse("2026-03-10T18:00:00.000Z"),
        });
        expect(nextOccurrence?.id).not.toBe(todo.id);
        expect(await client.listTodos()).toEqual([nextOccurrence]);
        expect(await client.listTodos("?status=done")).toEqual([completed]);
      });
    });
  });

  it("answers a to-do without a rule with no next occurrence and stores nothing new", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      const todo = await client.add({ dueDate: "2026-03-10" });

      const completion = await client.complete(todo.id);

      expect(completion.nextOccurrence).toBeNull();
      expect(completion.completedAt).toEqual(expect.any(Number));
      expect(storedCount()).toBe(1);
    });
  });

  it.each([
    ["day", { every: 3, unit: "day" }, "2026-03-13"],
    ["week", { every: 1, unit: "week" }, "2026-03-17"],
    ["month", { every: 2, unit: "month" }, "2026-05-10"],
    ["year", { every: 1, unit: "year" }, "2027-03-10"],
  ])("advances the due date by a %s rule", async (_unit, repeat, expected) => {
    await withApp(async (app) => {
      const client = await household(app);
      await withClock("2026-03-10T09:00:00.000Z", async () => {
        const todo = await client.add({ dueDate: "2026-03-10", repeat });
        expect((await client.complete(todo.id)).nextOccurrence?.dueDate).toBe(expected);
      });
    });
  });

  it("a to-do finished three cycles late gets one next occurrence, after today", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      await withClock("2026-03-24T09:00:00.000Z", async () => {
        const todo = await client.add({
          dueDate: "2026-03-02",
          repeat: { every: 1, unit: "week" },
        });

        const completion = await client.complete(todo.id);

        expect(completion.nextOccurrence?.dueDate).toBe("2026-03-30");
        expect(storedCount()).toBe(2);
      });
    });
  });

  it("an occurrence that would fall on today is skipped", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      await withClock("2026-03-10T09:00:00.000Z", async () => {
        const todo = await client.add({
          dueDate: "2026-03-03",
          repeat: { every: 1, unit: "week" },
        });
        expect((await client.complete(todo.id)).nextOccurrence?.dueDate).toBe("2026-03-17");
      });
    });
  });

  it.each([
    // 16:00 UTC on 9 March is already 10 March in Tokyo.
    ["ahead of UTC", "Asia/Tokyo", "2026-03-09T16:00:00.000Z", "2026-03-09", "2026-03-11"],
    // 02:00 UTC on 10 March is still 9 March in New York.
    ["behind UTC", "America/New_York", "2026-03-10T02:00:00.000Z", "2026-03-09", "2026-03-10"],
    ["on UTC", "UTC", "2026-03-10T02:00:00.000Z", "2026-03-09", "2026-03-11"],
  ])(
    "takes today from the household timezone %s",
    async (_label, timezone, instant, dueDate, expected) => {
      await withApp(async (app) => {
        const client = await household(app);
        setHouseholdTimezone(timezone);
        await withClock(instant, async () => {
          const todo = await client.add({ dueDate, repeat: { every: 1, unit: "day" } });
          expect((await client.complete(todo.id)).nextOccurrence?.dueDate).toBe(expected);
        });
      });
    }
  );

  it("a monthly to-do due on the 31st goes 28 Feb and back to 31 Mar", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      await withClock("2026-01-31T09:00:00.000Z", async (at) => {
        const january = await client.add({ dueDate: "2026-01-31", repeat: MONTHLY });

        const february = (await client.complete(january.id)).nextOccurrence;
        expect(february?.dueDate).toBe("2026-02-28");

        at("2026-02-28T09:00:00.000Z");
        const march = (await client.complete(february!.id)).nextOccurrence;
        expect(march?.dueDate).toBe("2026-03-31");

        at("2026-03-31T09:00:00.000Z");
        expect((await client.complete(march!.id)).nextOccurrence?.dueDate).toBe("2026-04-30");
      });
    });
  });

  it("a yearly to-do due on 29 February returns to the 29th in the next leap year", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      await withClock("2027-02-28T09:00:00.000Z", async () => {
        const leap = await client.add({
          dueDate: "2024-02-29",
          repeat: { every: 1, unit: "year" },
        });

        // Finished three years late: 2025, 2026 and 2027 are skipped.
        expect((await client.complete(leap.id)).nextOccurrence?.dueDate).toBe("2028-02-29");
      });
    });
  });

  it("an edit that leaves due date and rule alone keeps the original day of the month", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      await withClock("2026-01-31T09:00:00.000Z", async (at) => {
        const january = await client.add({ dueDate: "2026-01-31", repeat: MONTHLY });
        const february = (await client.complete(january.id)).nextOccurrence!;

        await client.call("PATCH", `/api/todos/${february.id}`, {
          title: "Pagar el seguro",
          dueDate: "2026-02-28",
          repeat: MONTHLY,
        });
        at("2026-02-28T09:00:00.000Z");

        expect((await client.complete(february.id)).nextOccurrence).toMatchObject({
          title: "Pagar el seguro",
          dueDate: "2026-03-31",
        });
      });
    });
  });

  it.each([
    ["the due date", { dueDate: "2026-02-20" }, "2026-03-20"],
    ["the rule", { repeat: { every: 2, unit: "month" } }, "2026-04-28"],
  ])("an edit that changes %s anchors on the due date again", async (_label, patch, expected) => {
    await withApp(async (app) => {
      const client = await household(app);
      await withClock("2026-01-31T09:00:00.000Z", async () => {
        const january = await client.add({ dueDate: "2026-01-31", repeat: MONTHLY });
        const february = (await client.complete(january.id)).nextOccurrence!;

        expect((await client.call("PATCH", `/api/todos/${february.id}`, patch)).statusCode).toBe(
          200
        );

        expect((await client.complete(february.id)).nextOccurrence?.dueDate).toBe(expected);
      });
    });
  });

  it("creates no next occurrence past the year 9999 and still completes", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      const todo = await client.add({ dueDate: "9999-06-01", repeat: { every: 1, unit: "year" } });

      const completion = await client.complete(todo.id);

      expect(completion.completedAt).toEqual(expect.any(Number));
      expect(completion.nextOccurrence).toBeNull();
      expect(storedCount()).toBe(1);
    });
  });
});

describe("todos repeat — one next occurrence per to-do", () => {
  useIsolatedDb();

  it("a second completion creates nothing and reports no next occurrence", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      await withClock("2026-03-10T09:00:00.000Z", async (at) => {
        const todo = await client.add({ dueDate: "2026-03-10", repeat: MONTHLY });
        const first = await client.complete(todo.id);
        at("2026-03-11T09:00:00.000Z");

        const second = await client.complete(todo.id);

        expect(second).toEqual({ ...first, nextOccurrence: null });
        expect(await client.listTodos()).toEqual([first.nextOccurrence]);
        expect(storedCount()).toBe(2);
      });
    });
  });

  it("two completions sent at once create one next occurrence", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      await withClock("2026-03-10T09:00:00.000Z", async () => {
        const todo = await client.add({ dueDate: "2026-03-10", repeat: MONTHLY });

        const completions = await Promise.all([
          client.complete(todo.id),
          client.complete(todo.id),
          client.complete(todo.id),
        ]);

        const created = completions.flatMap(({ nextOccurrence }) => nextOccurrence ?? []);
        expect(created).toHaveLength(1);
        expect(await client.listTodos()).toEqual(created);
        expect(storedCount()).toBe(2);
      });
    });
  });

  it("reopening keeps the occurrence already created, and completing again creates no other", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      await withClock("2026-03-10T09:00:00.000Z", async () => {
        const todo = await client.add({ dueDate: "2026-03-10", repeat: MONTHLY });
        const { nextOccurrence } = await client.complete(todo.id);

        const reopened = await client.call("DELETE", `/api/todos/${todo.id}/completion`);
        expect(reopened.statusCode).toBe(200);
        expect(reopened.json<Todo>()).toMatchObject({ completedAt: null, repeat: MONTHLY });
        expect(reopened.json()).not.toHaveProperty("nextOccurrence");
        expect((await client.listTodos()).map((item) => item.id)).toEqual([
          todo.id,
          nextOccurrence!.id,
        ]);

        const again = await client.complete(todo.id);

        expect(again.completedAt).toEqual(expect.any(Number));
        expect(again.nextOccurrence).toBeNull();
        expect(await client.listTodos()).toEqual([nextOccurrence]);
        expect(storedCount()).toBe(2);
      });
    });
  });

  it("a done to-do that is given a rule afterwards creates nothing when completed again", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      const todo = await client.add({ dueDate: "2026-03-10" });
      await client.complete(todo.id);
      expect(
        (await client.call("PATCH", `/api/todos/${todo.id}`, { repeat: MONTHLY })).statusCode
      ).toBe(200);

      const again = await client.complete(todo.id);

      expect(again).toMatchObject({ repeat: MONTHLY, nextOccurrence: null });
      expect(storedCount()).toBe(1);
    });
  });

  it("leaves the to-do open when its next occurrence cannot be stored", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      const todo = await client.add({ dueDate: "2026-03-10", repeat: MONTHLY });
      getDb().exec(
        `CREATE TEMP TRIGGER refuse_new_todos BEFORE INSERT ON todo_items
         BEGIN SELECT RAISE(ABORT, 'refused'); END`
      );
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const response = await client.call("POST", `/api/todos/${todo.id}/completion`);

        expect(response.statusCode).toBe(500);
        expect(response.json<{ error: string }>().error).toBe("internal_error");
        expect((await client.call("GET", `/api/todos/${todo.id}`)).json()).toEqual(todo);
        expect(storedCount()).toBe(1);
      } finally {
        logged.mockRestore();
        getDb().exec("DROP TRIGGER refuse_new_todos");
      }
    });
  });

  it("deleting the created occurrence does not let the completed to-do create another", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      const todo = await client.add({ dueDate: "2026-03-10", repeat: MONTHLY });
      const { nextOccurrence } = await client.complete(todo.id);
      expect((await client.call("DELETE", `/api/todos/${nextOccurrence!.id}`)).statusCode).toBe(
        204
      );

      await client.call("DELETE", `/api/todos/${todo.id}/completion`);
      const again = await client.complete(todo.id);

      expect(again.nextOccurrence).toBeNull();
      expect(storedCount()).toBe(1);
    });
  });

  it("deleting the completed to-do keeps the occurrence it created, which repeats in turn", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      await withClock("2026-03-10T09:00:00.000Z", async () => {
        const todo = await client.add({ dueDate: "2026-03-10", repeat: MONTHLY });
        const { nextOccurrence } = await client.complete(todo.id);

        expect((await client.call("DELETE", `/api/todos/${todo.id}`)).statusCode).toBe(204);

        expect(await client.listTodos("?status=all")).toEqual([nextOccurrence]);
        expect((await client.complete(nextOccurrence!.id)).nextOccurrence?.dueDate).toBe(
          "2026-05-10"
        );
      });
    });
  });
});

describe("todos repeat — assignee of the next occurrence", () => {
  useIsolatedDb();

  it.each([
    ["was archived", (id: string) => archiveMember(id)],
    [
      "became a child",
      (id: string) =>
        void getDb().prepare("UPDATE members SET role = 'child' WHERE id = ?").run(id),
    ],
    [
      "was removed",
      (id: string) => void getDb().prepare("DELETE FROM members WHERE id = ?").run(id),
    ],
  ])("is nobody when the assignee %s; the completion still succeeds", async (_label, change) => {
    await withApp(async (app) => {
      const client = await household(app);
      const assigneeMemberId = seedMember("parent");
      const todo = await client.add({ dueDate: "2026-03-10", assigneeMemberId, repeat: MONTHLY });
      change(assigneeMemberId);

      const completion = await client.complete(todo.id);

      expect(completion.assigneeMemberId).toBe(assigneeMemberId);
      expect(completion.completedAt).toEqual(expect.any(Number));
      expect(completion.nextOccurrence).toMatchObject({ assigneeMemberId: null, repeat: MONTHLY });
    });
  });

  it("stays nobody for an unassigned to-do", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      const todo = await client.add({ dueDate: "2026-03-10", repeat: MONTHLY });
      expect((await client.complete(todo.id)).nextOccurrence?.assigneeMemberId).toBeNull();
    });
  });
});

describe("todos repeat — stored shape", () => {
  useIsolatedDb();

  it.each([
    ["an interval of 0", "repeat_every = 0"],
    ["an interval of 100", "repeat_every = 100"],
    ["a fractional interval", "repeat_every = 1.5"],
    ["an unknown unit", "repeat_unit = 'hour'"],
    ["a rule without an interval", "repeat_every = NULL"],
    ["a rule without a unit", "repeat_unit = NULL"],
    ["a rule without an anchor day", "repeat_anchor_day = NULL"],
    ["an anchor day of 32", "repeat_anchor_day = 32"],
    ["a rule without a due date", "due_date = NULL"],
  ])("the table refuses %s", async (_label, assignment) => {
    await withApp(async (app) => {
      const client = await household(app);
      const todo = await client.add({ dueDate: "2026-03-10", repeat: MONTHLY });

      expect(() =>
        getDb().prepare(`UPDATE todo_items SET ${assignment} WHERE id = ?`).run(todo.id)
      ).toThrow(/CHECK constraint failed/);
    });
  });

  it("the table refuses an anchor day or an interval on a to-do without a rule", async () => {
    await withApp(async (app) => {
      const client = await household(app);
      const todo = await client.add({ dueDate: "2026-03-10" });
      const set = (assignment: string) => () =>
        getDb().prepare(`UPDATE todo_items SET ${assignment} WHERE id = ?`).run(todo.id);

      expect(set("repeat_anchor_day = 10")).toThrow(/CHECK constraint failed/);
      expect(set("repeat_every = 1")).toThrow(/CHECK constraint failed/);
    });
  });
});

describe(`${MIGRATION} on a database that already holds to-dos`, () => {
  /** A database migrated up to 0003 with one list and two to-dos, then given this migration. */
  function migrated(): Database.Database {
    const db = new Database(":memory:");
    execBaseline(db);
    const earlier = SHIPPED_MIGRATION_FILES.filter(
      (file) => file !== BASELINE_FILE && file < MIGRATION
    );
    db.pragma("foreign_keys = OFF");
    for (const file of earlier) db.exec(readFileSync(`drizzle/${file}`, "utf8"));
    db.pragma("foreign_keys = ON");
    db.exec(
      `INSERT INTO todo_lists (id, name, created_at, updated_at) VALUES ('home', 'Home', 1, 1);
       INSERT INTO todo_items
         (id, list_id, title, notes, due_date, assignee_member_id, completed_at, created_at, updated_at)
       VALUES
         ('open', 'home', 'Renew the car insurance', 'Policy number', '2026-12-01', 'member-1', NULL, 2, 3),
         ('done', 'home', 'Call the plumber', NULL, NULL, NULL, 5, 4, 5);`
    );
    // The runner applies a rebuild with foreign keys off, so the drop cascades nothing.
    db.pragma("foreign_keys = OFF");
    db.exec(readFileSync(`drizzle/${MIGRATION}`, "utf8"));
    db.pragma("foreign_keys = ON");
    return db;
  }

  it("keeps every to-do as it was, with no rule", () => {
    const db = migrated();
    try {
      expect(db.prepare("SELECT * FROM todo_items ORDER BY created_at").all()).toEqual([
        {
          id: "open",
          list_id: "home",
          title: "Renew the car insurance",
          notes: "Policy number",
          due_date: "2026-12-01",
          assignee_member_id: "member-1",
          completed_at: null,
          created_at: 2,
          updated_at: 3,
          repeat_every: null,
          repeat_unit: null,
          repeat_anchor_day: null,
          next_todo_id: null,
        },
        {
          id: "done",
          list_id: "home",
          title: "Call the plumber",
          notes: null,
          due_date: null,
          assignee_member_id: null,
          completed_at: 5,
          created_at: 4,
          updated_at: 5,
          repeat_every: null,
          repeat_unit: null,
          repeat_anchor_day: null,
          next_todo_id: null,
        },
      ]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("keeps the indexes, the earlier checks and the cascade from the list", () => {
    const db = migrated();
    try {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'todo_items'")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(indexes).toEqual(
        expect.arrayContaining(["todo_items_list_id_idx", "todo_items_due_date_idx"])
      );
      expect(() => db.exec("UPDATE todo_items SET title = ' ' WHERE id = 'open'")).toThrow(
        /CHECK constraint failed/
      );
      expect(() => db.exec("UPDATE todo_items SET due_date = 'soon' WHERE id = 'open'")).toThrow(
        /CHECK constraint failed/
      );

      db.exec(
        "UPDATE todo_items SET repeat_every = 2, repeat_unit = 'week', repeat_anchor_day = 1 WHERE id = 'open'"
      );
      expect(() => db.exec("UPDATE todo_items SET repeat_unit = 'hour' WHERE id = 'open'")).toThrow(
        /CHECK constraint failed/
      );

      db.exec("DELETE FROM todo_lists WHERE id = 'home'");
      expect(db.prepare("SELECT COUNT(*) AS count FROM todo_items").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
