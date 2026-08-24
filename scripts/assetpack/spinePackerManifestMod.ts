import fs from "node:fs";
import {
  type Asset,
  type AssetPipe,
  findAssets,
  path,
  stripTags,
} from "@assetpack/core";
import { SPINE_PACKER_NAME } from "./spinePacker";

export type SpinePackerManifestModOptions = {
  output: string;
};

type ManifestAsset = {
  alias: string[];
  src: (string | { src: string })[];
  data?: unknown;
};

type Manifest = { bundles: { name: string; assets: ManifestAsset[] }[] };

/**
 * Splits a packed skeleton's single manifest entry into the trio the runtime
 * looks for.
 *
 * `pixiManifest` sees one source asset — the skeleton — and writes one entry
 * listing everything it generated as that entry's `src`s. But
 * `ManifestParser.getSpineAssets` discovers a spine by matching `<id>.atlas` +
 * `<id>.json` + `<id>.png` as three separate entries, so the one entry has to
 * become three.
 *
 * Must run **after** `pixiManifest`, whose output it rewrites in place.
 */
export function spinePackerManifestMod(
  options: SpinePackerManifestModOptions,
): AssetPipe<SpinePackerManifestModOptions> {
  return {
    name: "spine-packer-manifest",
    folder: false,
    defaultOptions: { ...options },

    async finish(rootAsset, opts, pipeSystem) {
      const sources = findAssets(
        (asset) =>
          asset.transformName === SPINE_PACKER_NAME &&
          asset.transformChildren.length > 0,
        rootAsset,
        true,
      );

      if (sources.length === 0) return;

      const manifestPath =
        path.dirname(opts.output) === "."
          ? path.joinSafe(pipeSystem.outputPath, opts.output)
          : opts.output;
      const manifest = JSON.parse(
        fs.readFileSync(manifestPath, "utf8"),
      ) as Manifest;

      for (const source of sources) {
        splitEntry(
          manifest,
          source,
          pipeSystem.outputPath,
          pipeSystem.entryPath,
        );
      }

      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    },
  };
}

/** `@0.7x` anywhere in a filename, the same rung marker Pixi's resolver reads. */
const RESOLUTION_SUFFIX = /@[0-9.]+x/;

function splitEntry(
  manifest: Manifest,
  source: Asset,
  outputPath: string,
  entryPath: string,
) {
  const directory = path.dirname(
    stripTags(path.relative(entryPath, source.path)),
  );

  // One entry per file the skeleton generated, except that its resolution rungs
  // share one: the resolver picks between the srcs of a single entry, so
  // `symbol.atlas` and `symbol@0.7x.atlas` have to arrive as two srcs under the
  // alias `symbol.atlas` rather than as two entries the bundle would then load
  // both of. Full size leads, so a resolution nothing matched falls back to it
  // rather than to whichever name happened to sort first.
  const rungs = new Map<string, Asset[]>();

  for (const generated of source.transformChildren) {
    const key = stripTags(generated.filename).replace(RESOLUTION_SUFFIX, "");

    rungs.set(key, [...(rungs.get(key) ?? []), generated]);
  }

  const entries = [...rungs].map(([filename, generated]) => {
    const alias = directory === "." ? filename : `${directory}/${filename}`;

    return {
      alias: [alias, filename],
      src: generated.flatMap((asset) =>
        asset
          .getFinalTransformedChildren()
          .map((final) => path.relative(outputPath, final.path)),
      ),
    } satisfies ManifestAsset;
  });

  const anySrc = entries[0]?.src[0];

  if (anySrc === undefined) return;

  // The skeleton's own entry is found by one of the srcs it generated, since
  // the entry is keyed by the source asset's name rather than by anything the
  // pipe chose.
  for (const bundle of manifest.bundles) {
    const index = bundle.assets.findIndex((asset) =>
      asset.src.some((s) => srcOf(s) === anySrc),
    );

    if (index === -1) continue;

    const { data } = bundle.assets[index];

    bundle.assets.splice(
      index,
      1,
      ...entries.map((entry) => ({ ...entry, data })),
    );

    return;
  }
}

function srcOf(src: string | { src: string }): string {
  return typeof src === "string" ? src : src.src;
}
