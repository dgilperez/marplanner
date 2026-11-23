import { describe, expect, it } from "vitest";
import type { Todo } from "../../src/shared";
import { useIsolatedDb } from "../helpers/db";
import { archiveMember, seedDeviceKey, seedMember, todosClient, withApp } from "../helpers/todos";

describe("todos assignee — adults only, checked on write (ADR-068)", () => {
  useIsolatedDb();

  const REJECTED = [
    ["a child", () => seedMember("child")],
    ["an archived parent", () => seedMember("parent", "archived")],
    ["an unknown member", () => "missing"],
    ["a non-string value", () => 42],
  ] as const;

  it.each(REJECTED)("POST assigning %s -> 400 and nothing is stored", async (_label, assignee) => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");

      const response = await client.call("POST", "/api/todos", {
        listId: list.id,
        title: "Fix the tap",
        assigneeMemberId: assignee(),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe("validation_error");
      expect(await client.listTodos("?status=all")).toEqual([]);
    });
  });

  it.each(REJECTED)(
    "PATCH assigning %s -> 400 and the assignee is unchanged",
    async (_label, assignee) => {
      await withApp(async (app) => {
        const client = todosClient(app, seedDeviceKey());
        const list = await client.createList("Home");
        const parentId = seedMember("parent");
        const todo = await client.createTodo({
          listId: list.id,
          title: "Fix the tap",
          assigneeMemberId: parentId,
        });

        const response = await client.call("PATCH", `/api/todos/${todo.id}`, {
          assigneeMemberId: assignee(),
        });

        expect(response.statusCode).toBe(400);
        expect((await client.call("GET", `/api/todos/${todo.id}`)).json()).toEqual(todo);
      });
    }
  );

  it("PATCH reassigns to another active parent", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");
      const todo = await client.createTodo({
        listId: list.id,
        title: "Fix the tap",
        assigneeMemberId: seedMember("parent"),
      });
      const otherParentId = seedMember("parent");

      const response = await client.call("PATCH", `/api/todos/${todo.id}`, {
        assigneeMemberId: otherParentId,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<Todo>().assigneeMemberId).toBe(otherParentId);
    });
  });

  it("reads keep returning the stored id after the assignee is archived", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");
      const parentId = seedMember("parent");
      const todo = await client.createTodo({
        listId: list.id,
        title: "Fix the tap",
        assigneeMemberId: parentId,
      });
      archiveMember(parentId);

      const single = await client.call("GET", `/api/todos/${todo.id}`);

      expect(single.statusCode).toBe(200);
      expect(single.json<Todo>().assigneeMemberId).toBe(parentId);
      expect(await client.listTodos(`?assigneeMemberId=${parentId}`)).toEqual([todo]);
    });
  });

  it("an archived assignee does not block edits that leave the assignee alone", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");
      const parentId = seedMember("parent");
      const todo = await client.createTodo({
        listId: list.id,
        title: "Fix the tap",
        assigneeMemberId: parentId,
      });
      archiveMember(parentId);

      const retitled = await client.call("PATCH", `/api/todos/${todo.id}`, { title: "Fix taps" });
      const resent = await client.call("PATCH", `/api/todos/${todo.id}`, {
        dueDate: "2026-12-01",
        assigneeMemberId: parentId,
      });
      const completed = await client.call("POST", `/api/todos/${todo.id}/completion`);

      expect(retitled.statusCode).toBe(200);
      expect(resent.statusCode).toBe(200);
      expect(resent.json<Todo>()).toMatchObject({
        dueDate: "2026-12-01",
        assigneeMemberId: parentId,
      });
      expect(completed.statusCode).toBe(200);
    });
  });

  it("assigneeMemberId filters by the stored id; an unknown member has no to-dos", async () => {
    await withApp(async (app) => {
      const client = todosClient(app, seedDeviceKey());
      const list = await client.createList("Home");
      const parentId = seedMember("parent");
      const mine = await client.createTodo({
        listId: list.id,
        title: "Fix the tap",
        assigneeMemberId: parentId,
      });
      await client.createTodo({ listId: list.id, title: "Unassigned" });
      await client.createTodo({
        listId: list.id,
        title: "Someone else's",
        assigneeMemberId: seedMember("parent"),
      });

      expect(await client.listTodos(`?assigneeMemberId=${parentId}`)).toEqual([mine]);
      expect(await client.listTodos("?assigneeMemberId=missing")).toEqual([]);
    });
  });
});
