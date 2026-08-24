import fs from "node:fs";
import path from "node:path";
import {
  defineConfig,
  type Plugin,
  type ResolvedConfig,
  type ViteDevServer,
} from "vite";
import { AssetPack, type AssetPackConfig } from "@assetpack/core";
import { pixiManifest } from "@assetpack/core/manifest";
import {
  spinePacker,
  spinePackerManifestMod,
} from "./scripts/assetpack/index.ts";

// ─── Project layout ─────────────────────────────────────────────────────────
// Everything the site is built from lives in ./assets — there is deliberately
// no `public/` folder in the repo root. The web root is *generated* instead,
// inside ./.assetpack (gitignored, disposable, safe to delete at any time):
//
//   assets/static/**              → copied verbatim to the web root
//                                   (/style.css, /favicon.png, …)
//   assets/<everything else>/**   → run through AssetPack + a Pixi manifest
//                                   (/assets/**, /assets/manifest.json)
//   assets/**/*.spine             → Spine editor projects, never shipped
//
//   .assetpack/public/            → the generated web root (Vite's publicDir)
//   .assetpack/cache/             → AssetPack's own cache location
//
// Vite serves .assetpack/public on `dev` and copies it into dist/ on `build`,
// which is why dev and production resolve the exact same URLs.
const ASSETS_DIR = "assets";
// The web-root folder, matched by its name with any AssetPack tag suffix
// stripped — `static`, `static{copy}` and `static{ignore}` all resolve to it.
// AssetPack never sees this folder, so tags on it have no effect either way.
const STATIC_FOLDER = "static";
const PUBLIC_DIR = path.join(".assetpack", "public");
const ASSETPACK_OUT = path.join(PUBLIC_DIR, "assets");
// AssetPack wipes its cache location on startup when `cache: false`. Keeping it
// in a sibling folder (rather than at .assetpack/) means that wipe can never
// take the generated web root with it.
const ASSETPACK_CACHE = path.join(".assetpack", "cache");

// The name of the generated manifest, relative to the AssetPack output. It is
// pixiManifest's own default; spinePackerManifestMod has to be told, because it
// reads that file back to patch it.
const MANIFEST = "manifest.json";

// AssetPack processes the source assets in ./assets and emits the
// runtime-ready tree + a PixiJS Assets manifest into .assetpack/public/assets.
//
// The pipeline is intentionally lean: no texture compression / cache-busting,
// so the Spine `.atlas` page references (bg.png, bg-1.png, …) stay intact and
// the generated manifest matches what spine-layout's ManifestParser expects:
//   - every asset's first alias is its full relative path (e.g. "spine/bg.atlas")
//   - basename shortcuts ("bg.atlas", "texts.json") are added when unambiguous
const assetpackConfig: AssetPackConfig = {
  entry: `./${ASSETS_DIR}`,
  output: `./${ASSETPACK_OUT}`,
  cache: false,
  cacheLocation: ASSETPACK_CACHE,
  // The static folder is copied straight to the web root by syncStaticFiles()
  // below, so AssetPack must not also process it (it would land under /assets/
  // and show up in the manifest as a loadable asset). Both the bare and the
  // tagged folder name are ignored. `.spine` files are Spine editor projects,
  // needed at design time only and never loaded at runtime — spinePacker also
  // consumes them, this keeps them out of the tree it walks at all.
  ignore: [
    `${STATIC_FOLDER}/**`,
    `${STATIC_FOLDER}\\{*\\}/**`,
    "**/*.spine",
    "**/.DS_Store",
  ],
  pipes: [
    // Packs Spine's raw export (skeleton `.json` + a shared `img/` folder of
    // loose images) into the `.json` + `.atlas` + page(s) trio the runtime
    // discovers spines by, so no packed atlas is ever committed. Would have to
    // come before `json()` and `mipmap()` if those were ever added — it must
    // claim the skeleton and the loose images before either processes them.
    spinePacker({
      spineAtlas: {
        maximumTextureSize: 2048,
        padding: 8,
        allowRotation: false,
      },
      // A single rung: nothing here picks a texture resolution at runtime, so a
      // smaller one would be built and shipped for no reader. Adding
      // `low: 0.7` here is all it takes to ladder every atlas.
      resolutionOptions: { resolutions: { default: 1 } },
    }),
    pixiManifest({
      output: MANIFEST,
      createShortcuts: true,
      includeMetaData: false,
      trimExtensions: false,
    }),
    // Splits each packed skeleton's single manifest entry into that trio. After
    // pixiManifest, whose output it rewrites.
    spinePackerManifestMod({ output: MANIFEST }),
  ],
};

// Locates the static folder inside ./assets, ignoring any AssetPack tag suffix
// on its name, so re-tagging it (`static` → `static{copy}`) cannot silently
// stop the web root from being populated.
function resolveStaticDir(): string | undefined {
  if (!fs.existsSync(ASSETS_DIR)) return undefined;

  const match = fs
    .readdirSync(ASSETS_DIR, { withFileTypes: true })
    .find(
      (entry) =>
        entry.isDirectory() &&
        entry.name.replace(/\{[^}]*\}/g, "") === STATIC_FOLDER,
    );

  return match && path.join(ASSETS_DIR, match.name);
}

// Mirrors the static folder into the root of the generated web root, so those
// files are served at `/` (dev) and land next to index.html in dist/ (build).
// Stale entries are pruned, but the AssetPack output subtree is never touched.
function syncStaticFiles() {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });

  for (const entry of fs.readdirSync(PUBLIC_DIR)) {
    if (path.join(PUBLIC_DIR, entry) === ASSETPACK_OUT) continue;
    fs.rmSync(path.join(PUBLIC_DIR, entry), { recursive: true, force: true });
  }

  const staticDir = resolveStaticDir();
  if (staticDir) fs.cpSync(staticDir, PUBLIC_DIR, { recursive: true });
}

// True for files inside ./assets/<static folder>/, whatever tags its name
// carries — resolved per event so folder renames during dev are picked up.
function isStaticFile(file: string) {
  const rel = path.relative(path.resolve(ASSETS_DIR), path.resolve(file));
  if (!rel || rel.startsWith("..")) return false;

  const [topLevel] = rel.split(path.sep);
  return topLevel.replace(/\{[^}]*\}/g, "") === STATIC_FOLDER;
}

// Generates the web root: the static folder copied verbatim, everything else
// run through AssetPack. In `serve` AssetPack watches for changes; in `build` it
// runs once during buildStart, before Vite copies publicDir into dist/.
function assetpackPlugin(): Plugin {
  const apConfig = assetpackConfig;
  let mode: ResolvedConfig["command"];
  let ap: AssetPack | undefined;
  let server: ViteDevServer | undefined;

  return {
    name: "vite-plugin-assetpack",
    configResolved(resolvedConfig) {
      mode = resolvedConfig.command;
      // Runs here, not in buildStart, because Vite snapshots the publicDir file
      // list when the dev server starts and only serves what is in that
      // snapshot (plus whatever its watcher sees appear afterwards).
      syncStaticFiles();
    },
    configureServer(devServer) {
      // Kept so buildStart — which runs after this hook and owns the AssetPack
      // instance — can reload the page once a rebuild lands.
      server = devServer;

      // publicDir contents are not part of the module graph, so edits to the
      // static folder need an explicit re-copy + page reload.
      const onStaticChange = (file: string) => {
        if (!isStaticFile(file)) return;
        syncStaticFiles();
        devServer.ws.send({ type: "full-reload" });
      };

      devServer.watcher.add(path.resolve(ASSETS_DIR));
      devServer.watcher.on("add", onStaticChange);
      devServer.watcher.on("change", onStaticChange);
      devServer.watcher.on("unlink", onStaticChange);
    },
    buildStart: async () => {
      if (mode === "serve") {
        if (ap) return;
        ap = new AssetPack(apConfig);
        void ap.watch((root) => {
          // AssetPack reads a source file once and then keeps the bytes on the
          // asset, dropping them only in the branch its own cache runs in —
          // which `cache: false` above turns off. Left alone, every rebuild
          // after the first one re-runs the pipes over the *first* build's
          // bytes: files appearing and disappearing are tracked, edits to their
          // contents are not, so an edited skeleton or sprite is repacked
          // byte-for-byte identical and the page never changes. Releasing the
          // buffers is what AssetPack does when cached, and it makes the next
          // build read from disk again.
          root.releaseChildrenBuffers();

          // The rebuild lands in publicDir, outside Vite's module graph, so
          // nothing there tells the page its assets changed. This closes the
          // loop: edit a sprite/spine/sound/json under ./assets, AssetPack
          // reprocesses it (debounced, incremental), the page reloads and
          // refetches. It also covers the very first build, which finishes
          // after the browser has already been opened.
          server?.ws.send({ type: "full-reload" });
        });
      } else {
        await new AssetPack(apConfig).run();
      }
    },
    buildEnd: async () => {
      server = undefined;
      if (ap) {
        await ap.stop();
        ap = undefined;
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // Served from the repo subpath on GitHub Pages, from root in local dev.
  base: command === "build" ? "/slot-engine/" : "/",
  // The generated web root — there is no ./public in this repo.
  publicDir: PUBLIC_DIR,
  server: {
    port: 8080,
    open: true,
  },
  // Pixi + top-level await in main.ts need a modern output target.
  build: {
    target: "esnext",
  },
  plugins: [assetpackPlugin()],
}));
