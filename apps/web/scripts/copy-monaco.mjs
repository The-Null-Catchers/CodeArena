import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const root = dirname(require.resolve("monaco-editor/package.json"));
mkdirSync("public/monaco", { recursive: true });
cpSync(join(root, "min/vs"), "public/monaco/vs", { recursive: true });
