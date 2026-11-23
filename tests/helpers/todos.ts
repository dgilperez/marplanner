import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import type { Todo, TodoList } from "../../src/shared";

export function seedDeviceKey(): string {
  const deviceKey = `mpk-${randomUUID()}`;
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
    )
    .run(randomUUID(), hashKey(deviceKey), Date.now());
  return deviceKey;
}

export function seedMember(
  role: "parent" | "child" = "parent",
  lifecycle: "active" | "archived" = "active"
): string {
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO members (id, display_name, role, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, `Member ${id.slice(0, 6)}`, role, lifecycle, now, now);
  return id;
}

export function archiveMember(id: string): void {
  getDb().prepare("UPDATE members SET lifecycle = 'archived' WHERE id = ?").run(id);
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/** An authenticated client for the todos HTTP surface; `call` returns the raw inject response. */
export function todosClient(app: FastifyInstance, deviceKey: string) {
  const call = (method: Method, url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      cookies: { mp_device_key: deviceKey },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  return {
    call,
    async createList(name: string): Promise<TodoList> {
      const response = await call("POST", "/api/todos/lists", { name });
      if (response.statusCode !== 201) throw new Error(`createList failed: ${response.body}`);
      return response.json<TodoList>();
    },
    async createTodo(body: Record<string, unknown>): Promise<Todo> {
      const response = await call("POST", "/api/todos", body);
      if (response.statusCode !== 201) throw new Error(`createTodo failed: ${response.body}`);
      return response.json<Todo>();
    },
    async listTodos(query = ""): Promise<Todo[]> {
      const response = await call("GET", `/api/todos${query}`);
      if (response.statusCode !== 200) throw new Error(`listTodos failed: ${response.body}`);
      return response.json<Todo[]>();
    },
  };
}

export async function withApp<T>(run: (app: FastifyInstance) => Promise<T>): Promise<T> {
  const { buildApp } = await import("../../src/server/app.ts");
  const app = await buildApp();
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}
