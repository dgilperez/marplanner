/** Example build-time extension (ADR-068): one table, two routes.
 *
 * Build it into the server with `MP_EXTENSIONS_DIR=examples/extensions npm run build`, then
 * activate it in Admin → Plugins or with `POST /api/plugins/ext-hello/activate`.
 */
import { defineExtension, type ServerExtension } from "@marplanner/extension";
import { getDb } from "@marplanner/host-api";

interface GreetingRow {
  id: number;
  text: string;
}

const extension: ServerExtension = {
  manifest: defineExtension({
    id: "ext-hello",
    labelKey: "ext.ext-hello.label",
    descriptionKey: "ext.ext-hello.description",
    contributions: { routes: ["ext-hello-api"] },
  }),
  // Tables are prefixed with the extension's data namespace: `ext-hello` owns `ext_hello_*`.
  migrations: [
    {
      id: "0001_greetings",
      apply: () => {
        getDb().exec(
          `CREATE TABLE ext_hello_greetings (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             text TEXT NOT NULL CHECK (length(trim(text)) > 0)
           )`
        );
        return undefined;
      },
    },
  ],
  // Mounted under /api/ext/ext-hello/, behind the device credential and the lifecycle gate.
  routes: async (app) => {
    app.get("/greetings", async () => ({
      greetings: getDb()
        .prepare("SELECT id, text FROM ext_hello_greetings ORDER BY id")
        .all() as GreetingRow[],
    }));
    app.post("/greetings", async (request, reply) => {
      const text = (request.body as { text?: unknown } | null)?.text;
      if (typeof text !== "string" || text.trim().length === 0) {
        return reply.code(400).send({ code: "invalid_greeting", message: "text is required." });
      }
      const { lastInsertRowid } = getDb()
        .prepare("INSERT INTO ext_hello_greetings (text) VALUES (?)")
        .run(text.trim());
      return reply.code(201).send({ id: Number(lastInsertRowid), text: text.trim() });
    });
  },
};

export default extension;
