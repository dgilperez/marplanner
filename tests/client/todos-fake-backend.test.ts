import { afterEach, describe, expect, it, vi } from "vitest";

import { readJson } from "@/lib/api";
import type { Todo } from "../../src/shared";
import { DUE_RANGE_CASES, DUE_RANGE_REFUSALS, DUE_RANGE_SEEDS } from "../helpers/todos-due-range";
import { todosBackend } from "./helpers/todosBackend";

/** The in-memory API has to answer like the real one, or a client test proves nothing. These
 * cases are the ones `tests/boundary/todos-due-range.test.ts` runs against the real API. */
describe("in-memory to-dos API — due date range", () => {
  afterEach(() => vi.unstubAllGlobals());

  const seeded = () =>
    todosBackend({
      lists: [{ id: "home", name: "Home" }],
      todos: DUE_RANGE_SEEDS.map((seed, index) => ({
        id: `todo-${index}`,
        listId: "home",
        title: seed.title,
        dueDate: seed.dueDate,
        completedAt: seed.done ? 1 : null,
      })),
    });

  it.each(DUE_RANGE_CASES)("%s", async (_label, query, expected) => {
    seeded();
    const todos = await readJson<Todo[]>(`/api/todos${query}`);
    expect(todos.map((todo) => todo.title)).toEqual(expected);
  });

  it.each(DUE_RANGE_REFUSALS)("GET with %s -> 400", async (_label, query) => {
    seeded();
    await expect(readJson(`/api/todos${query}`)).rejects.toMatchObject({
      status: 400,
      code: "validation_error",
    });
  });
});
