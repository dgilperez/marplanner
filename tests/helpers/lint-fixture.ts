import path from "node:path";
import { ESLint, type Linter } from "eslint";
import tsEslint from "typescript-eslint";

const repoRoot = path.resolve(__dirname, "../..");

/** Lint `code` with the real `eslint.config.mjs` as if it lived at `relativeFilePath`. The file
 * does not have to exist; only its import targets are resolved against the tree. */
export async function lintFixture(
  relativeFilePath: string,
  code: string
): Promise<Linter.LintMessage[]> {
  const eslint = new ESLint({ cwd: repoRoot, overrideConfig: tsEslint.configs.disableTypeChecked });
  const results = await eslint.lintText(code, { filePath: path.join(repoRoot, relativeFilePath) });
  return results[0]?.messages ?? [];
}
