// soksak-plugin-browser 번들 빌드 — esbuild 단일 ESM main.js(loader 가 blob-URL 로 import).
// React 인라인 번들. 전역 CSS 는 소스 문자열(src/styles.ts)로 1회 주입.
import { build, context } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(root, "src");

const opts = {
  entryPoints: ["src/plugin-entry.tsx"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  alias: { "@": SRC },
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env.DEV": "false",
  },
  outfile: "main.js",
  minify: false,
  legalComments: "none",
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("[browser] watching src → main.js …");
} else {
  await build(opts);
  console.log("[browser] built main.js");
}
