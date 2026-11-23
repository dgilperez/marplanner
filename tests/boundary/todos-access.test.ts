import { describe, expect, it } from "vitest";
import { useIsolatedDb } from "../helpers/db";
import { seedDeviceKey, todosClient, withApp } from "../helpers/todos";

const ROUTES = [
  ["GET", "/api/todos/lists"],
  ["POST", "/api/todos/lists"],
  ["PATCH", "/api/todos/lists/any"],
  ["DELETE", "/api/todos/lists/any"],
  ["GET", "/api/todos"],
  ["POST", "/api/todos"],
  ["GET", "/api/todos/any"],
  ["PATCH", "/api/todos/any"],
  ["DELETE", "/api/todos/any"],
  ["POST", "/api/todos/any/completion"],
  ["DELETE", "/api/todos/any/completion"],
] as const;

describe("todos access — device credential", () => {
  useIsolatedDb();

  it.each(ROUTES)("%s %s without a credential -> 401", async (method, url) => {
    await withApp(async (app) => {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(401);
    });
  });
});

describe("todos access — plugin lifecycle gate", () => {
  useIsolatedDb({ pluginState: "inactive" });

  it("installs the plugin inactive", async () => {
    await withApp(async (app) => {
      const response = await todosClient(app, seedDeviceKey()).call("GET", "/api/plugins");
      const plugins = response.json<{ plugins: { id: string; state: string }[] }>().plugins;
      expect(plugins.find((plugin) => plugin.id === "todos")?.state).toBe("inactive");
    });
  });

  it.each(ROUTES)("%s %s while the plugin is inactive -> 503", async (method, url) => {
    await withApp(async (app) => {
      const response = await todosClient(app, seedDeviceKey()).call(method, url);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        code: "plugin_unavailable",
        message: "This plugin is unavailable.",
      });
    });
  });
});
