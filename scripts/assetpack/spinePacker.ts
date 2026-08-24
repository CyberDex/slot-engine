import {
  type Asset,
  type AssetPipe,
  BuildReporter,
  createNewAssetAt,
  findAssets,
  path,
  stripTags,
} from "@assetpack/core";
import {
  collectSkeletonRegions,
  matchRegionName,
  pickImageFolderName,
} from "./spineRegions";
import {
  packSpineAtlas,
  type SpineAtlasOptions,
  type SpineAtlasScale,
} from "./packSpineAtlas";

export const SPINE_PACKER_NAME = "spine-packer";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

const PROJECT_EXTENSION = ".spine";

/**
 * The rungs a skeleton is packed at, named as `mipmap` and `texturePacker` name
 * theirs so a game configures all three the same way. `fixedResolution` is the
 * one a skeleton tagged `{fix}` keeps on its own — art a smaller rung would
 * visibly cost, which for a slot is the symbols and the logo rather than the
 * painted background behind them.
 */
export type SpinePackerResolutionOptions = {
  resolutions?: Record<string, number>;
  fixedResolution?: string;
  template?: string;
};

export type SpinePackerOptions = {
  spineAtlas?: SpineAtlasOptions;
  resolutionOptions?: SpinePackerResolutionOptions;
};

const RESOLUTION_DEFAULTS: Required<SpinePackerResolutionOptions> = {
  resolutions: { default: 1 },
  fixedResolution: "default",
  template: "@%%x",
};

/**
 * Packs Spine's unpacked export — a skeleton `.json` beside a folder of loose
 * images — into the `.json` + `.atlas` + page(s) trio the runtime looks for, so
 * the repo can commit the raw export and never a packed one.
 *
 * Must run **before** `json()` and `mipmap()`: it has to claim the skeleton
 * before `json()` gets it, and claim the loose source images before `mipmap()`
 * starts laddering them. Those images are consumed here, so they reach neither
 * the output nor the manifest.
 *
 * A no-op for a skeleton that ships with its own `.atlas`, so it is safe to
 * leave wired up whatever a game commits.
 */
export function spinePacker(
  options: SpinePackerOptions = {},
): AssetPipe<SpinePackerOptions> {
  let imageFolders = new Map<string, Asset | undefined>();

  function findImageFolder(asset: Asset): Asset | undefined {
    if (imageFolders.has(asset.path)) return imageFolders.get(asset.path);

    const folder = resolveImageFolder(asset);

    imageFolders.set(asset.path, folder);

    return folder;
  }

  function claimants(folder: Asset): Asset[] {
    return (folder.parent?.children ?? []).filter(
      (sibling) =>
        isSkeletonFile(sibling) && findImageFolder(sibling) === folder,
    );
  }

  /**
   * The skeletons an image belongs to, found by walking up from the image until
   * a folder some skeleton claims as its own is reached — so a nested
   * `img/symbols/H1.png` is owned by whoever claimed `img/`.
   */
  function owningSkeletons(asset: Asset): Asset[] {
    if (!IMAGE_EXTENSIONS.includes(asset.extension.toLowerCase())) return [];

    for (let folder = asset.parent; folder; folder = folder.parent) {
      const owners = claimants(folder);

      if (owners.length > 0) return owners;
    }

    return [];
  }

  function isSpineSourceImage(asset: Asset): boolean {
    return owningSkeletons(asset).length > 0;
  }

  return {
    name: SPINE_PACKER_NAME,
    folder: false,
    defaultOptions: {
      spineAtlas: {},
      ...options,
    },

    tags: {
      fix: "fix",
    },

    async start(rootAsset) {
      imageFolders = new Map();

      // AssetPack only re-transforms what changed, so editing an image would
      // otherwise leave its atlas stale: mark the owning skeleton modified
      // before AssetPack decides what to rebuild.
      const changedImages = findAssets(
        (asset) =>
          !asset.isFolder &&
          asset.state !== "normal" &&
          isSpineSourceImage(asset),
        rootAsset,
        false,
      );

      for (const image of changedImages) {
        for (const skeleton of owningSkeletons(image)) {
          if (skeleton.state === "normal") skeleton.state = "modified";
        }
      }
    },

    test(asset) {
      if (asset.isFolder) return false;
      if (asset.extension.toLowerCase() === PROJECT_EXTENSION) return true;
      if (isSpineSourceImage(asset)) return true;

      return isSkeletonFile(asset) && findImageFolder(asset) !== undefined;
    },

    async transform(asset, transformOptions) {
      // Source material, consumed: a `.spine` project is a design-time file,
      // and the images now live inside the pages packed below.
      if (asset.extension.toLowerCase() === PROJECT_EXTENSION) return [];
      if (isSpineSourceImage(asset)) return [];

      const imageFolder = findImageFolder(asset)!;
      const name = stripTags(path.trimExt(asset.filename));

      let skeleton: unknown;

      try {
        skeleton = JSON.parse(asset.buffer.toString());
      } catch {
        return [asset];
      }

      const regions = collectSkeletonRegions(skeleton);

      if (!regions.isSkeleton) return [asset];

      const inputs = [];
      const claimedBy = new Map<string, string>();

      for (const image of collectImages(imageFolder)) {
        const regionName = matchRegionName(image.regionPath, regions.names);

        if (!regionName) continue;

        const claimant = claimedBy.get(regionName);

        if (claimant !== undefined) {
          // Packing both would put two blocks of one name in the atlas, and
          // only ever draw one: `findRegion` returns the first match, and which
          // one that is falls out of the packing order. So keep the first and
          // say which was dropped — reported through `error` so a `strict`
          // build stops on it.
          BuildReporter.error(
            `[spine-packer] "${name}" region "${regionName}" is claimed by two images in ${stripTags(imageFolder.filename)}/: ${claimant} and ${image.sourcePath}. Packing ${claimant}, ignoring ${image.sourcePath} — rename or remove one.`,
          );

          continue;
        }

        claimedBy.set(regionName, image.sourcePath);
        inputs.push({
          name: regionName,
          contents: image.asset.buffer,
          ...(regions.meshNames.has(regionName) ? { allowTrim: false } : {}),
        });
      }

      const missing = [...regions.names].filter(
        (region) => !claimedBy.has(region),
      );

      if (missing.length > 0) {
        BuildReporter.warn(
          `[spine-packer] "${name}" references regions with no image in ${stripTags(imageFolder.filename)}/: ${missing.join(", ")}`,
        );
      }

      const scales = resolutionScales(
        transformOptions.resolutionOptions,
        asset.allMetaData[this.tags!.fix],
      );

      const packs = await packSpineAtlas(
        name,
        inputs,
        transformOptions.spineAtlas,
        scales,
      );

      if (packs[0].pages.length > 1) {
        BuildReporter.warn(
          `[spine-packer] "${name}" did not fit on one page (${packs[0].pages.length} pages). Raise spineAtlas.maximumTextureSize or split the skeleton.`,
        );
      }

      // One skeleton for the lot: what a rung changes is how many texels a
      // region is stored in, and Spine reads a region's drawn size off the
      // attachment and its texel size off the atlas. So the atlas carries the
      // resolution and the skeleton stays as exported.
      const skeletonAsset = createNewAssetAt(asset, `${name}.json`);

      skeletonAsset.buffer = asset.buffer;

      const generated = packs.flatMap(({ atlasText, pages }, index) => {
        const atlasAsset = createNewAssetAt(
          asset,
          `${name}${scales[index].suffix}.atlas`,
        );

        atlasAsset.buffer = Buffer.from(atlasText);

        return [
          atlasAsset,
          ...pages.map((page) => {
            const pageAsset = createNewAssetAt(asset, page.name);

            pageAsset.buffer = page.buffer;
            // The page is already at its final size; mipmap must not scale it
            // again.
            pageAsset.metaData.nomip = true;

            return pageAsset;
          }),
        ];
      });

      BuildReporter.log(
        `[spine-packer] ${name}: packed ${inputs.length} images into ${name}.atlas` +
          (scales.length > 1
            ? ` at ${scales.map(({ scale }) => `${scale}x`).join(", ")}`
            : ""),
      );

      return [skeletonAsset, ...generated];
    },
  };
}

function resolutionScales(
  options: SpinePackerResolutionOptions | undefined,
  fixed: unknown,
): SpineAtlasScale[] {
  const { resolutions, fixedResolution, template } = {
    ...RESOLUTION_DEFAULTS,
    ...options,
  };
  const wanted = fixed
    ? [resolutions[fixedResolution] ?? 1]
    : Object.values(resolutions);
  const largest = Math.max(...wanted);

  return wanted
    .sort((a, b) => b - a)
    .map((resolution) => ({
      scale: resolution / largest,
      // `1` keeps the bare name, matching what Pixi's resolver reads as
      // resolution 1 when a filename carries no `@Nx` at all.
      suffix:
        resolution === 1 ? "" : template.replace("%%", String(resolution)),
    }));
}

/** A `.json` with no sibling `.atlas` — i.e. an export that was not packed. */
function isSkeletonFile(asset: Asset): boolean {
  if (asset.isFolder || asset.extension.toLowerCase() !== ".json") return false;

  const name = stripTags(path.trimExt(asset.filename)).toLowerCase();

  return !(
    asset.parent?.children.some(
      (sibling) =>
        !sibling.isFolder &&
        stripTags(sibling.filename).toLowerCase() === `${name}.atlas`,
    ) ?? false
  );
}

function resolveImageFolder(asset: Asset): Asset | undefined {
  const folders = (asset.parent?.children ?? []).filter(
    (child) => child.isFolder && hasImages(child),
  );
  const name = stripTags(path.trimExt(asset.filename));
  const picked = pickImageFolderName(
    name,
    folders.map((folder) => stripTags(folder.filename)),
  );

  return folders.find((folder) => stripTags(folder.filename) === picked);
}

function hasImages(folder: Asset): boolean {
  return folder.children.some((child) =>
    child.isFolder
      ? hasImages(child)
      : IMAGE_EXTENSIONS.includes(child.extension.toLowerCase()),
  );
}

/**
 * Every image under an image folder, keyed by its path relative to that folder
 * — which is the name a skeleton references it by, subfolders and all.
 */
function collectImages(
  folder: Asset,
  prefix = "",
): { asset: Asset; regionPath: string; sourcePath: string }[] {
  const images: { asset: Asset; regionPath: string; sourcePath: string }[] = [];

  for (const child of folder.children) {
    const name = stripTags(child.filename);

    if (child.isFolder) {
      images.push(...collectImages(child, prefix ? `${prefix}/${name}` : name));
    } else if (IMAGE_EXTENSIONS.includes(child.extension.toLowerCase())) {
      const stem = path.trimExt(name);

      images.push({
        asset: child,
        regionPath: prefix ? `${prefix}/${stem}` : stem,
        sourcePath: prefix ? `${prefix}/${name}` : name,
      });
    }
  }

  return images;
}
