import { Application, Assets, type AssetsManifest } from "pixi.js";
import { SpineLayout } from "@pixijs-userland/spine-layout";

// Where AssetPack emitted the processed assets + manifest. `public/` is served
// at Vite's base URL (`/` in dev, `/spine-layout-tests/` on GitHub Pages), so
// resolve against BASE_URL rather than hardcoding a leading slash.
const ASSETS_BASE = `${import.meta.env.BASE_URL}assets/`;

// Everything runs inside main() rather than at module top level ON PURPOSE.
// Pixi's `app.init()` dynamically `import()`s the renderer, which in a
// production build is a separate chunk that depends on shared code in this
// entry chunk. A top-level `await` here would suspend the entry chunk mid-
// evaluation, so the renderer chunk (waiting on the entry chunk to finish)
// could never resolve — a deadlock that only surfaces in the bundled build,
// not in dev. Keeping the awaits inside a function lets the entry chunk finish
// evaluating synchronously, so the dynamic import can complete.
async function main() {
  // Create and initialize the application.
  const app = new Application();

  await app.init({
    resizeTo: window,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio, 2),
    autoDensity: true,
  });

  document.getElementById("pixi-container")!.appendChild(app.canvas);

  // ── 1. Load the AssetPack manifest and register it with Pixi's Assets ───────
  // Fetch the manifest directly (not via Assets.load) so we can hand it to
  // Assets.init *before* anything else touches Assets — otherwise the first load
  // auto-initializes it without our basePath and every asset URL resolves wrong.
  const manifest = (await fetch(`${ASSETS_BASE}manifest.json`).then((r) =>
    r.json(),
  )) as AssetsManifest;

  await Assets.init({ manifest, basePath: ASSETS_BASE });

  // ── 2. Preload everything the scene needs up front ─────────────────────────
  // Pixi has no built-in audio loader, so we load only the assets Pixi understands
  // (spine skeletons/atlases, bitmap fonts, the texts settings). Sounds are picked
  // up straight from the manifest by spine-layout's Howler-backed Sounds controller.
  const preloadAliases = manifest.bundles
    .flatMap((bundle) =>
      Array.isArray(bundle.assets) ? bundle.assets : [bundle.assets],
    )
    .map((asset) => {
      const alias = asset.alias;
      return Array.isArray(alias) ? alias[0] : alias;
    })
    .filter(
      (alias): alias is string =>
        typeof alias === "string" && /\.(atlas|json|fnt)$/.test(alias),
    );

  await Assets.load(preloadAliases);

  // ── 3. Build the scene from the manifest ───────────────────────────────────
  // createInstancesFromManifest scans the manifest for .atlas / .json / .png
  // triplets, instantiates each spine (resolving aliases as `spines/<id>.<ext>`),
  // then wires the hierarchy from the slot-naming conventions in the skeletons.
  const layout = new SpineLayout({ debug: true });
  await layout.createInstancesFromManifest(manifest, "spines");

  app.stage.addChild(layout);

  // ── 4. Center and fit the composed scene to the viewport ───────────────────
  // Scale purely to the scene height — the scene always fills the viewport height,
  // and width is left unconstrained (it may overflow horizontally off-screen).
  function fit() {
    const bounds = layout.getLocalBounds();
    if (!bounds.height) return;
    const scale = app.screen.height / bounds.height;
    layout.scale.set(scale);
    layout.position.set(
      app.screen.width / 2 - (bounds.x + bounds.width / 2) * scale,
      app.screen.height / 2 - (bounds.y + bounds.height / 2) * scale,
    );
  }

  fit();
  app.renderer.on("resize", fit);

  // Expose for quick console tinkering (playState / playEvent / texts / skins).
  (globalThis as unknown as { layout: SpineLayout }).layout = layout;

  // Everything is loaded and composed — drop the loading spinner.
  document.getElementById("loader")?.remove();
}

void main();
