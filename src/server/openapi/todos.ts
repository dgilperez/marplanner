// Code-first OpenAPI: route schemas for the to-dos HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import {
  TODO_LIST_NAME_MAX_LENGTH,
  TODO_NOTES_MAX_LENGTH,
  TODO_STATUS_FILTERS,
  TODO_TITLE_MAX_LENGTH,
} from "../../shared";
import { component, defineRouteSchemas, noContent, type RouteResponse } from "./zod";
import {
  ErrorSchema,
  PluginUnavailable,
  authUnauthorizedResponse,
  authenticationBackoffResponse,
} from "./common";

const dueDate = z.string().meta({ description: "YYYY-MM-DD (household-local)" });
const epochMs = z.int().meta({ description: "epoch ms" });
const listName = z.string().min(1).max(TODO_LIST_NAME_MAX_LENGTH).meta({
  description: "trimmed before it is stored; unique among lists, compared exactly.",
});
const title = z
  .string()
  .min(1)
  .max(TODO_TITLE_MAX_LENGTH)
  .meta({ description: "trimmed before it is stored." });
const notes = z
  .string()
  .max(TODO_NOTES_MAX_LENGTH)
  .meta({ description: "blank notes are stored as null." });
const assigneeMemberId = z.string().meta({
  description:
    "soft reference to members.id. A write that changes it requires an active member whose role is parent.",
});

export const TodoList = component(
  "TodoList",
  z.strictObject({
    id: z.string(),
    name: listName,
    openCount: z.int().min(0).meta({ description: "to-dos in the list that are not done." }),
    createdAt: epochMs,
    updatedAt: epochMs,
  })
);

export const TodoListWrite = component("TodoListWrite", z.strictObject({ name: listName }));

export const Todo = component(
  "Todo",
  z.strictObject({
    id: z.string(),
    listId: z.string(),
    title,
    notes: notes.nullable(),
    dueDate: dueDate.nullable(),
    assigneeMemberId: z.string().nullable().meta({
      description:
        "stored member id, returned as it is even when that member has been archived or removed.",
    }),
    completedAt: epochMs.nullable().meta({ description: "set while the to-do is done." }),
    createdAt: epochMs,
    updatedAt: epochMs,
  })
);

export const TodoCreate = component(
  "TodoCreate",
  z.strictObject({
    listId: z.string().meta({ description: "must reference an existing list." }),
    title,
    notes: notes.nullable().optional(),
    dueDate: dueDate.nullable().optional(),
    assigneeMemberId: assigneeMemberId.nullable().optional(),
  })
);

export const TodoPatch = component(
  "TodoPatch",
  z.strictObject({
    listId: z.string().optional(),
    title: title.optional(),
    notes: notes.nullable().optional(),
    dueDate: dueDate.nullable().optional(),
    assigneeMemberId: assigneeMemberId.nullable().optional(),
  }),
  { minProperties: 1 }
);

const json = (description: string, schema: z.ZodType): RouteResponse => ({
  description,
  content: { "application/json": { schema } },
});

const idParams = z.object({ id: z.string() });
const security = [{ deviceKeyCookie: [] }];
const tags = ["todos"];

/** Responses every to-dos route shares: the device credential boundary and the lifecycle gate. */
const gated = {
  401: authUnauthorizedResponse,
  429: authenticationBackoffResponse,
  503: json("The owning plugin is inactive or unavailable.", PluginUnavailable),
};
const unknownList = json("unknown list id", ErrorSchema);
const unknownTodo = json("unknown to-do id", ErrorSchema);
const duplicateName = json("another list already has that name (`duplicate_name`)", ErrorSchema);

export const todosSchemas = defineRouteSchemas({
  /** GET /api/todos/lists */
  getTodoLists: {
    operationId: "getTodoLists",
    tags,
    summary: "Every list ordered by name (ASCII case ignored), each with its count of open to-dos.",
    security,
    response: { 200: json("all lists (possibly empty)", z.array(TodoList)), ...gated },
  },
  /** POST /api/todos/lists */
  postTodoLists: {
    operationId: "postTodoLists",
    tags,
    summary: "Create a list.",
    security,
    body: TodoListWrite,
    response: {
      201: json("created", TodoList),
      400: json("non-object body, unsupported field, or invalid name", ErrorSchema),
      409: duplicateName,
      ...gated,
    },
  },
  /** PATCH /api/todos/lists/{id} */
  patchTodoListsById: {
    operationId: "patchTodoListsById",
    tags,
    summary: "Rename a list.",
    security,
    params: idParams,
    body: TodoListWrite,
    response: {
      200: json("renamed", TodoList),
      400: json("non-object body, unsupported field, or invalid name", ErrorSchema),
      404: unknownList,
      409: duplicateName,
      ...gated,
    },
  },
  /** DELETE /api/todos/lists/{id} */
  deleteTodoListsById: {
    operationId: "deleteTodoListsById",
    tags,
    summary: "Delete a list together with every to-do in it.",
    security,
    params: idParams,
    response: { 204: noContent("deleted"), 404: unknownList, ...gated },
  },
  /** GET /api/todos */
  getTodos: {
    operationId: "getTodos",
    tags,
    summary:
      "To-dos matching every given filter. Order: open before done, then due date ascending with undated last, then creation order.",
    security,
    querystring: z.object({
      listId: z.string().optional(),
      status: z.enum(TODO_STATUS_FILTERS).meta({ default: "open" }).optional(),
      dueBy: z
        .string()
        .meta({
          description:
            "YYYY-MM-DD. Keeps to-dos due on or before this date, overdue ones included; undated to-dos are dropped.",
        })
        .optional(),
      assigneeMemberId: z
        .string()
        .meta({ description: "matches the stored id; the member may be archived." })
        .optional(),
    }),
    response: {
      200: json("matching to-dos (possibly empty)", z.array(Todo)),
      400: json("unknown status, invalid dueBy, or a repeated parameter", ErrorSchema),
      ...gated,
    },
  },
  /** POST /api/todos */
  postTodos: {
    operationId: "postTodos",
    tags,
    summary: "Create an open to-do in a list.",
    security,
    body: TodoCreate,
    response: {
      201: json("created", Todo),
      400: json(
        "non-object body, unsupported field, invalid field, unknown list, or an assignee who is not an active parent",
        ErrorSchema
      ),
      ...gated,
    },
  },
  /** GET /api/todos/{id} */
  getTodosById: {
    operationId: "getTodosById",
    tags,
    summary: "Read one to-do.",
    security,
    params: idParams,
    response: { 200: json("the to-do", Todo), 404: unknownTodo, ...gated },
  },
  /** PATCH /api/todos/{id} */
  patchTodosById: {
    operationId: "patchTodosById",
    tags,
    summary:
      "Partial edit: only the named fields change and null clears a nullable field. The assignee is checked only when the request changes it. Completion is not editable here.",
    security,
    params: idParams,
    body: TodoPatch,
    response: {
      200: json("updated", Todo),
      400: json(
        "non-object or empty body, unsupported field, invalid field, unknown list, or a new assignee who is not an active parent",
        ErrorSchema
      ),
      404: unknownTodo,
      ...gated,
    },
  },
  /** DELETE /api/todos/{id} */
  deleteTodosById: {
    operationId: "deleteTodosById",
    tags,
    summary: "Delete a to-do.",
    security,
    params: idParams,
    response: { 204: noContent("deleted"), 404: unknownTodo, ...gated },
  },
  /** POST /api/todos/{id}/completion */
  postTodosByIdCompletion: {
    operationId: "postTodosByIdCompletion",
    tags,
    summary: "Mark a to-do done. Idempotent: a to-do that is already done keeps its completedAt.",
    security,
    params: idParams,
    response: { 200: json("the done to-do", Todo), 404: unknownTodo, ...gated },
  },
  /** DELETE /api/todos/{id}/completion */
  deleteTodosByIdCompletion: {
    operationId: "deleteTodosByIdCompletion",
    tags,
    summary: "Reopen a to-do. Idempotent: an open to-do is returned unchanged.",
    security,
    params: idParams,
    response: { 200: json("the open to-do", Todo), 404: unknownTodo, ...gated },
  },
});
