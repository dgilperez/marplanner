import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiFetch, jsonRequest, readJson } from "@/lib/api";
import { PLUGIN_UNAVAILABLE_RESPONSE } from "../../src/shared";
import { json, stubFetchRoutes } from "./helpers/fetchRoutes";

afterEach(() => vi.unstubAllGlobals());

async function failure(response: Response): Promise<ApiError> {
  stubFetchRoutes({ "GET /api/thing": () => response });
  const error = await apiFetch("/api/thing").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe("apiFetch", () => {
  it("returns a 2xx response and reads its JSON", async () => {
    stubFetchRoutes({ "GET /api/thing": () => json({ ok: true }) });
    expect((await apiFetch("/api/thing")).status).toBe(200);
    expect(await readJson("/api/thing")).toEqual({ ok: true });
  });

  it("rejects with the code a route puts in `error`", async () => {
    const error = await failure(json({ error: "duplicate_name", message: "private" }, 409));
    expect(error).toMatchObject({ status: 409, code: "duplicate_name" });
    expect(error.message).toBe("/api/thing: 409");
  });

  it("rejects with the `code` of the plugin lifecycle gate's 503", async () => {
    expect(await failure(json(PLUGIN_UNAVAILABLE_RESPONSE, 503))).toMatchObject({
      status: 503,
      code: "plugin_unavailable",
    });
  });

  it("prefers the route's `error` when a body carries both", async () => {
    const body = { error: "unauthorized", code: "scope_denied", message: "private" };
    expect((await failure(json(body, 403))).code).toBe("unauthorized");
  });

  it.each([
    ["no JSON body", new Response("<html>", { status: 502 })],
    ["a body without a code", json({ message: "private" }, 500)],
    ["codes that are not strings", json({ error: 1, code: { nested: true } }, 500)],
    ["a null body", json(null, 500)],
  ])("rejects without a code for %s", async (_label, response) => {
    expect((await failure(response)).code).toBeNull();
  });

  it("builds a JSON request", () => {
    expect(jsonRequest("PATCH", { name: "Home" })).toEqual({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: '{"name":"Home"}',
    });
  });
});
