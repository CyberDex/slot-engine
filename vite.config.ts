import { defineConfig, type Plugin, type ResolvedConfig } from "vite";
import { AssetPack, type AssetPackConfig } from "@assetpack/core";
import { pixiManifest } from "@assetpack/core/manifest";

// AssetPack processes the raw source assets in ./raw-assets and emits the
// runtime-ready tree + a PixiJS Assets manifest into ./public/assets.
//
// The pipeline is intentionally lean: no texture compression / cache-busting,
// so the Spine `.atlas` page references (root.png, root_2.png, …) stay intact
// and the generated manifest matches what spine-layout's ManifestParser expects:
//   - every asset's first alias is its full relative path (e.g. "spines/root.atlas")
//   - basename shortcuts ("root.atlas", "texts.json") are added when unambiguous
const assetpackConfig: AssetPackConfig = {
  entry: "./raw-assets",
  output: "./public/assets",
  cache: false,
  // The `source/` tree is the raw Spine editor projects (only needed at design
  // time); `.spine` are editor project files. Neither is loaded at runtime.
  ignore: ["source/**", "**/*.spine", "logo.svg", "**/.DS_Store"],
  pipes: [
    pixiManifest({
      createShortcuts: true,
      includeMetaData: false,
      trimExtensions: false,
    }),
  ],
};

// Runs AssetPack over ./raw-assets. In `serve` it watches for changes; in
// `build` it runs once (during buildStart, before Vite copies public/ to dist/).
function assetpackPlugin(): Plugin {
  const apConfig = assetpackConfig;
  let mode: ResolvedConfig["command"];
  let ap: AssetPack | undefined;

  return {
    name: "vite-plugin-assetpack",
    configResolved(resolvedConfig) {
      mode = resolvedConfig.command;
    },
    buildStart: async () => {
      if (mode === "serve") {
        if (ap) return;
        ap = new AssetPack(apConfig);
        void ap.watch();
      } else {
        await new AssetPack(apConfig).run();
      }
    },
    buildEnd: async () => {
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
  base: command === "build" ? "/spine-layout-tests/" : "/",
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
