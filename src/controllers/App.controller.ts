import type { ApplicationOptions, ArrayOr, AssetsManifest } from "pixi.js";
import { Application, Assets } from "pixi.js";

export class AppController extends Application {
  /** The AssetPack manifest, available once `init()` has resolved. */
  manifest!: AssetsManifest;

  async init(options?: Partial<ApplicationOptions>) {
    await super.init({
      resizeTo: window,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio, 2),
      autoDensity: true,
      ...options,
    });

    this.manifest = await this.loadAssets();

    document.getElementById("loader")?.remove();
    document.getElementById("pixi-container")!.appendChild(this.canvas);
  }

  async loadAssets(bundles?: ArrayOr<string>) {
    const assetsBase = `${import.meta.env.BASE_URL}assets/`;

    const manifest = (await fetch(`${assetsBase}manifest.json`).then((r) =>
      r.json(),
    )) as AssetsManifest;

    await Assets.init({
      manifest,
      basePath: assetsBase,
      texturePreference: { resolution: Math.min(window.devicePixelRatio, 2) },
    });

    await Assets.loadBundle(bundles ?? ["default"]);

    return manifest;
  }
}
