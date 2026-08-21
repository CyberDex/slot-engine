// @pixijs-userland/spine-layout is published from GitHub as TypeScript *source*
// only (its npm tarball has no built `dist/`). Its package.json still points
// `main`/`types`/`import` at `./dist`, so we compile it once after install.
//
// Runs on `prepare` (i.e. after every `pnpm install`), which is why it also
// re-writes the build tsconfig each time — a fresh install wipes node_modules.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const pkgDir = fileURLToPath(
  new URL("../node_modules/@pixijs-userland/spine-layout/", import.meta.url),
);

if (!existsSync(path.join(pkgDir, "src", "index.ts"))) {
  console.log("[build-spine-layout] package not installed yet, skipping.");
  process.exit(0);
}

if (existsSync(path.join(pkgDir, "dist", "index.js"))) {
  process.exit(0); // already built
}

const tsconfig = {
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    moduleDetection: "force",
    skipLibCheck: true,
    resolveJsonModule: true,
    strict: true,
    declaration: true,
    outDir: "dist",
    rootDir: "src",
  },
  include: ["src"],
};

const tsconfigPath = path.join(pkgDir, "tsconfig.build.json");
writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

console.log("[build-spine-layout] compiling dist…");
execFileSync(require.resolve("typescript/bin/tsc"), ["-p", tsconfigPath], {
  cwd: pkgDir,
  stdio: "inherit",
});
console.log("[build-spine-layout] done.");
