import { describe, expect, it } from "vitest";
import { lintFixture } from "../helpers/lint-fixture";

const MODULE = "src/server/modules/todos";
const restrictedPath = expect.objectContaining({ ruleId: "import-x/no-restricted-paths" });

describe("todos-rule-b — import boundary of the todos module (ADR-039 §2b′)", () => {
  it.each([
    [
      "the database client",
      `import { getDb } from "../../db/client";\nexport const use = getDb;\n`,
    ],
    [
      "members internals",
      `import { listActiveMembers } from "../members/referential";\nexport const use = listActiveMembers;\n`,
    ],
    [
      "a peer plugin module",
      `import { getMessage } from "../daily-messages/index";\nexport const use = getMessage;\n`,
    ],
  ])("rejects an import of %s", async (_label, code) => {
    const messages = await lintFixture(`${MODULE}/__fixture_forbidden__.ts`, code);
    expect(messages).toEqual(expect.arrayContaining([restrictedPath]));
  });

  it.each([
    [
      "the host-API barrel",
      `import { getDb, listActiveMembers } from "../../host-api";\nexport const use = { getDb, listActiveMembers };\n`,
    ],
    ["a shared DTO", `import type { Todo } from "../../../shared";\nexport type Use = Todo;\n`],
  ])("allows an import of %s", async (_label, code) => {
    const messages = await lintFixture(`${MODULE}/__fixture_allowed__.ts`, code);
    expect(messages).not.toEqual(expect.arrayContaining([restrictedPath]));
  });

  it("rejects a direct process.env read", async () => {
    const messages = await lintFixture(
      `${MODULE}/__fixture_env__.ts`,
      `export const value = process.env.TODOS_ANYTHING;\n`
    );
    expect(messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: "no-restricted-syntax" })])
    );
  });
});
