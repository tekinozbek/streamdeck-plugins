import ts from "typescript";
import { defineConfig } from "vitest/config";

// The actions use TypeScript's standard decorators, which Vitest's own transform leaves in place and Node can't run.
// Compile those files with TypeScript, as the build does.
const actions = {
  name: "compile-decorators",
  enforce: "pre",
  transform(code, id) {
    if (!/\/src\/actions\/[^/]+\.ts$/.test(id)) return undefined;
    const out = ts.transpileModule(code, {
      fileName: id,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, sourceMap: true },
    });
    return { code: out.outputText, map: JSON.parse(out.sourceMapText) };
  },
};

export default defineConfig({
  plugins: [actions],
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
