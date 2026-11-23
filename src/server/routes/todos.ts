import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  completeTodo,
  createTodo,
  createTodoList,
  deleteTodo,
  deleteTodoList,
  editTodo,
  getTodo,
  listTodoLists,
  listTodos,
  renameTodoList,
  reopenTodo,
  TodoListNameConflictError,
  TodoNotFoundError,
  TodoValidationError,
  type TodoFilters,
} from "../modules/todos/index";
import { todosSchemas } from "../openapi/todos";
import { documented } from "../openapi/zod";

type IdParams = { id: string };

/** Thin to-dos HTTP boundary: every rule lives in `modules/todos`; this file maps its typed
 * errors to HTTP statuses. The list routes are registered under `/api/todos/lists`, a static
 * segment that Fastify's router prefers over `/api/todos/:id`.
 */
export async function todosRoutes(app: FastifyInstance): Promise<void> {
  /** Runs `action` and sends its result with `status`; a void result sends an empty body. */
  const respond =
    <Request extends FastifyRequest>(status: number, action: (request: Request) => unknown) =>
    async (request: Request, reply: FastifyReply) => {
      try {
        const result = action(request);
        return await reply.code(status).send(result);
      } catch (err) {
        return handleTodoError(err, reply);
      }
    };
  const idOf = (request: FastifyRequest) => (request.params as IdParams).id;

  app.get("/api/todos/lists", documented(todosSchemas.getTodoLists), respond(200, listTodoLists));
  app.post(
    "/api/todos/lists",
    documented(todosSchemas.postTodoLists),
    respond(201, (request) => createTodoList(request.body))
  );
  app.patch(
    "/api/todos/lists/:id",
    documented(todosSchemas.patchTodoListsById),
    respond(200, (request) => renameTodoList(idOf(request), request.body))
  );
  app.delete(
    "/api/todos/lists/:id",
    documented(todosSchemas.deleteTodoListsById),
    respond(204, (request) => deleteTodoList(idOf(request)))
  );

  app.get(
    "/api/todos",
    documented(todosSchemas.getTodos),
    respond(200, (request) => listTodos(request.query as TodoFilters))
  );
  app.post(
    "/api/todos",
    documented(todosSchemas.postTodos),
    respond(201, (request) => createTodo(request.body))
  );
  app.get(
    "/api/todos/:id",
    documented(todosSchemas.getTodosById),
    respond(200, (request) => getTodo(idOf(request)))
  );
  app.patch(
    "/api/todos/:id",
    documented(todosSchemas.patchTodosById),
    respond(200, (request) => editTodo(idOf(request), request.body))
  );
  app.delete(
    "/api/todos/:id",
    documented(todosSchemas.deleteTodosById),
    respond(204, (request) => deleteTodo(idOf(request)))
  );
  app.post(
    "/api/todos/:id/completion",
    documented(todosSchemas.postTodosByIdCompletion),
    respond(200, (request) => completeTodo(idOf(request)))
  );
  app.delete(
    "/api/todos/:id/completion",
    documented(todosSchemas.deleteTodosByIdCompletion),
    respond(200, (request) => reopenTodo(idOf(request)))
  );
}

function handleTodoError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof TodoNotFoundError) {
    return reply.code(404).send({ error: "not_found", message: err.message });
  }
  if (err instanceof TodoListNameConflictError) {
    return reply.code(409).send({ error: "duplicate_name", message: err.message });
  }
  if (err instanceof TodoValidationError) {
    return reply.code(400).send({ error: "validation_error", message: err.message });
  }
  console.error("Unexpected error in todos handler:", err);
  return reply.code(500).send({ error: "internal_error", message: "An unexpected error occurred" });
}
