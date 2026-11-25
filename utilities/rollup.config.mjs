import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const watching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "io.github.tekinozbek.utilities.sdPlugin";
// Kept once at the repository root; copied into the plugin folder on every build so it ships with it.
const notices = fileURLToPath(new URL("../THIRD-PARTY-NOTICES.md", import.meta.url));

export default {
  input: "src/plugin.ts",
  output: { file: `${sdPlugin}/bin/plugin.js`, sourcemap: watching },
  plugins: [
    typescript(),
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs(),
    !watching && terser(),
    {
      name: "copy-third-party-notices",
      buildStart() {
        this.addWatchFile(notices);
        fs.copyFileSync(notices, `${sdPlugin}/THIRD-PARTY-NOTICES.md`);
      },
    },
    {
      name: "emit-module-package-file",
      generateBundle() {
        this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
      },
    },
  ],
};
