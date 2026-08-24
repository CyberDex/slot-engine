/**
 * What a skeleton asks its atlas for, and where those images live.
 *
 * These are conventions of Spine's own exporter rather than of this build, so
 * they sit apart from the pipe that consumes them: a skeleton exported as
 * "JSON only, no packing" still names its regions the way the packer would
 * have, and Spine writes a skeleton's images into a folder beside it.
 */

/** Folder names Spine's exporter uses for images shared by several skeletons. */
export const SPINE_IMAGE_FOLDER_NAMES = ["img", "images", "pictures"];

export type SkeletonRegions = {
  isSkeleton: boolean;
  names: Set<string>;
  /**
   * Subset of {@link names} reached by a mesh, which must be packed
   * **untrimmed**.
   *
   * A region attachment maps the packed rectangle onto a correspondingly
   * shrunk quad, so stripping an image's transparent border is invisible. A
   * mesh does not: `MeshAttachment` lays its UVs over the region's *original*
   * rectangle (`u -= offsetX / pageWidth`, `width = originalWidth /
   * pageWidth`), so the stripped margin still gets sampled — and on a packed
   * page that margin is whatever region was placed next door.
   */
  meshNames: Set<string>;
};

const IMAGE_ATTACHMENT_TYPES = ["region", "mesh", "linkedmesh"];

const MESH_ATTACHMENT_TYPES = ["mesh", "linkedmesh"];

/**
 * Every region name a skeleton's attachments reference, plus whether the file
 * is a skeleton at all — `bones` is the cheapest marker, since every skeleton
 * has at least a root bone and no other JSON in an asset folder does.
 *
 * Only the referenced names are collected, which is what lets several
 * skeletons share one image folder without each atlas holding all of it.
 */
export function collectSkeletonRegions(skeleton: unknown): SkeletonRegions {
  const { bones, skins } = (skeleton ?? {}) as {
    bones?: unknown;
    skins?: unknown;
  };
  // 4.x writes `skins` as an array of `{ name, attachments }`; 3.8 wrote it as
  // an object keyed by skin name.
  const skinAttachments: unknown[] = Array.isArray(skins)
    ? skins.map((skin) => (skin as { attachments?: unknown }).attachments)
    : Object.values((skins ?? {}) as Record<string, unknown>);

  const names = new Set<string>();
  const meshNames = new Set<string>();

  for (const slots of skinAttachments) {
    if (!slots || typeof slots !== "object") continue;

    for (const attachments of Object.values(slots as Record<string, unknown>)) {
      if (!attachments || typeof attachments !== "object") continue;

      for (const [key, value] of Object.entries(
        attachments as Record<string, unknown>,
      )) {
        const attachment = (value ?? {}) as {
          type?: string;
          path?: string;
          name?: string;
        };

        // An attachment with no `type` is a region — the exporter omits the
        // most common value.
        const type = attachment.type ?? "region";

        if (!IMAGE_ATTACHMENT_TYPES.includes(type)) continue;

        // `path` is the image the attachment was drawn from when it differs
        // from the attachment's own name.
        const name = attachment.path ?? attachment.name ?? key;

        names.add(name);

        if (MESH_ATTACHMENT_TYPES.includes(type)) meshNames.add(name);
      }
    }
  }

  return { isSkeleton: Array.isArray(bones), names, meshNames };
}

/**
 * The region name an image satisfies, or `undefined` if the skeleton never
 * asks for it.
 *
 * `regionPath` is the image's path relative to the image folder. A skeleton may
 * name a region by that whole path or by any tail of it, because Spine's packer
 * can flatten subfolders on export — so `symbols/H1_blur.png` answers to
 * `symbols/H1_blur` and to `H1_blur`. A trailing `_<n>` is a sequence frame's
 * index: the skeleton names the sequence, and each frame keeps its own index in
 * the atlas.
 */
export function matchRegionName(
  regionPath: string,
  names: Set<string>,
): string | undefined {
  const segments = regionPath.split("/");

  for (let start = 0; start < segments.length; start++) {
    const candidate = segments.slice(start).join("/");

    if (names.has(candidate)) return candidate;

    const withoutIndex = candidate.replace(/_\d+$/, "");

    if (withoutIndex !== candidate && names.has(withoutIndex)) return candidate;
  }

  return undefined;
}

/**
 * The folder holding one skeleton's images: one named after the skeleton, which
 * is what Spine writes per skeleton, or an `img` / `images` / `pictures` folder
 * beside it, shared by every skeleton in that folder.
 */
export function pickImageFolderName(
  skeletonName: string,
  folderNames: Iterable<string>,
): string | undefined {
  const names = [...folderNames];

  if (names.includes(skeletonName)) return skeletonName;

  for (const candidate of SPINE_IMAGE_FOLDER_NAMES) {
    const match = names.find((name) => name.toLowerCase() === candidate);

    if (match) return match;
  }

  return undefined;
}
