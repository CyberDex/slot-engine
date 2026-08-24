import { MaxRectsPacker } from "maxrects-packer";
import sharp from "sharp";

export type SpineRegionInput = {
  name: string;
  contents: Buffer;
  allowTrim?: boolean;
};

export type SpineAtlasOptions = {
  maximumTextureSize?: number;
  padding?: number;
  allowTrim?: boolean;
  allowRotation?: boolean;
  powerOfTwo?: boolean;
  alphaThreshold?: number;
};

export type SpineAtlasPage = {
  name: string;
  buffer: Buffer;
};

export type SpineAtlasPack = {
  scale: number;
  atlasText: string;
  pages: SpineAtlasPage[];
};

/**
 * One rung of the resolution ladder: `scale` shrinks every region, `suffix`
 * goes into the page and atlas filenames so Pixi's resolver can tell the rungs
 * apart (`@0.7x`).
 */
export type SpineAtlasScale = {
  scale: number;
  suffix: string;
};

const DEFAULTS = {
  maximumTextureSize: 2048,
  padding: 2,
  allowTrim: true,
  allowRotation: false,
  powerOfTwo: false,
  alphaThreshold: 0,
} satisfies Required<SpineAtlasOptions>;

const FULL_SCALE: SpineAtlasScale[] = [{ scale: 1, suffix: "" }];

type PreparedRegion = {
  name: string;
  buffer: Buffer;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  trimLeft: number;
  trimTop: number;
  trimmed: boolean;
};

type PackedRect = PreparedRegion & {
  x: number;
  y: number;
  rot: boolean;
};

/**
 * Packs one skeleton's regions into an atlas, in the 4.1+ text format Spine
 * itself writes, plus the page images to go with it.
 *
 * **Every rung is the same packing, shrunk.** The regions are trimmed and
 * packed once, at full size, and each smaller rung reuses that layout with
 * every coordinate multiplied through — so a skeleton has the same number of
 * pages under the same names at every resolution, whatever the packer decided.
 * That matters twice over: the Pixi manifest pairs the rungs up by filename,
 * and `ManifestParser` looks a spine's page up as `<name>.png`, so a rung that
 * packed into four pages where another took five would leave an entry with
 * nothing to pair with and a page fetched by a mobile that never draws it.
 *
 * The regions are resized individually rather than by shrinking the finished
 * page: a page's regions sit `padding` apart, which is nothing next to a
 * resampling kernel, so downscaling the sheet drags each sprite's neighbours in
 * over its edges.
 */
export async function packSpineAtlas(
  name: string,
  regions: SpineRegionInput[],
  options: SpineAtlasOptions = {},
  scales: SpineAtlasScale[] = FULL_SCALE,
): Promise<SpineAtlasPack[]> {
  const opts = { ...DEFAULTS, ...options };
  const prepared = await Promise.all(
    regions.map((region) => prepareRegion(region, opts)),
  );

  const packer = new MaxRectsPacker<PackedRect>(
    opts.maximumTextureSize,
    opts.maximumTextureSize,
    opts.padding,
    {
      smart: true,
      pot: opts.powerOfTwo,
      border: opts.padding,
      allowRotation: opts.allowRotation,
    },
  );

  // Plain objects, deliberately: the packer writes `x`, `y` and `rot` straight
  // onto whatever it was handed, so every rect must already own those fields
  // rather than inherit them.
  packer.addArray(
    prepared.map((region) => ({ ...region, x: 0, y: 0, rot: false })),
  );

  return Promise.all(
    packer.bins.length === 0
      ? scales.map((scale) => emptyPack(name, scale))
      : scales.map((scale) => packAtScale(name, packer.bins, opts, scale)),
  );
}

async function packAtScale(
  name: string,
  bins: { rects: PackedRect[] }[],
  opts: Required<SpineAtlasOptions>,
  { scale, suffix }: SpineAtlasScale,
): Promise<SpineAtlasPack> {
  const padding = Math.max(1, Math.round(opts.padding * scale));
  const pages: SpineAtlasPage[] = [];
  const blocks: string[] = [];

  for (let index = 0; index < bins.length; index++) {
    // The first page keeps the bare name, which is the one `ManifestParser`
    // pairs the skeleton with; anything that spilled follows it as `-1`, `-2`.
    const pageName = `${name}${suffix}${index === 0 ? "" : `-${index}`}.png`;
    const rects = await Promise.all(
      bins[index].rects.map((rect) => scaleRect(rect, scale)),
    );
    const { width, height } = fitPage(rects, opts, padding);

    pages.push({
      name: pageName,
      buffer: await composePage(rects, width, height),
    });
    blocks.push(serializePage(pageName, width, height, rects));
  }

  return { scale, atlasText: blocks.join("\n"), pages };
}

/**
 * A skeleton whose attachments reference nothing this folder has. It still gets
 * an atlas and a page, so the manifest entry the runtime looks for exists and
 * the spine loads (drawing nothing) instead of failing the whole layout.
 */
async function emptyPack(
  name: string,
  { scale, suffix }: SpineAtlasScale,
): Promise<SpineAtlasPack> {
  const pageName = `${name}${suffix}.png`;

  return {
    scale,
    atlasText: serializePage(pageName, 1, 1, []),
    pages: [{ name: pageName, buffer: await composePage([], 1, 1) }],
  };
}

async function scaleRect(rect: PackedRect, scale: number): Promise<PackedRect> {
  if (scale === 1) return rect;

  const width = shrink(rect.width, scale);
  const height = shrink(rect.height, scale);

  return {
    ...rect,
    // libvips premultiplies around a resize, so a sprite's transparent edge
    // does not bleed a halo of its own colour into the pixels the downscale
    // invents.
    buffer: await sharp(rect.buffer)
      .resize(width, height, { kernel: "lanczos3" })
      .png()
      .toBuffer(),
    width,
    height,
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    originalWidth: shrink(rect.originalWidth, scale),
    originalHeight: shrink(rect.originalHeight, scale),
    trimLeft: Math.round(rect.trimLeft * scale),
    trimTop: Math.round(rect.trimTop * scale),
  };
}

function shrink(value: number, scale: number): number {
  return Math.max(1, Math.round(value * scale));
}

async function prepareRegion(
  region: SpineRegionInput,
  opts: Required<SpineAtlasOptions>,
): Promise<PreparedRegion> {
  const image = sharp(region.contents);
  const { width: originalWidth, height: originalHeight } =
    await image.metadata();

  if (!originalWidth || !originalHeight) {
    throw new Error(
      `[spine-packer] Could not read image size for region "${region.name}"`,
    );
  }

  const base = {
    name: region.name,
    originalWidth,
    originalHeight,
    trimLeft: 0,
    trimTop: 0,
  };

  // sharp cannot trim a 1–2px image down to anything useful, and a fully
  // transparent image has nothing left to keep once its border is stripped —
  // both throw rather than return an empty region, so skip them.
  if (
    !(region.allowTrim ?? opts.allowTrim) ||
    originalWidth < 3 ||
    originalHeight < 3
  ) {
    return {
      ...base,
      buffer: await image.png().toBuffer(),
      width: originalWidth,
      height: originalHeight,
      trimmed: false,
    };
  }

  const { data, info } = await image
    .trim({
      threshold: opts.alphaThreshold,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer({ resolveWithObject: true });

  return {
    ...base,
    buffer: data,
    // sharp reports how far it moved the content, which is the negative of how
    // much it took off each edge.
    width: info.width,
    height: info.height,
    trimLeft: -(info.trimOffsetLeft ?? 0),
    trimTop: -(info.trimOffsetTop ?? 0),
    trimmed: info.width !== originalWidth || info.height !== originalHeight,
  };
}

function fitPage(
  rects: PackedRect[],
  opts: Required<SpineAtlasOptions>,
  padding: number,
) {
  let width = 0;
  let height = 0;

  for (const rect of rects) {
    width = Math.max(width, rect.x + (rect.rot ? rect.height : rect.width));
    height = Math.max(height, rect.y + (rect.rot ? rect.width : rect.height));
  }

  width += padding;
  height += padding;

  return opts.powerOfTwo
    ? { width: nearestPowerOfTwo(width), height: nearestPowerOfTwo(height) }
    : { width, height };
}

function nearestPowerOfTwo(value: number): number {
  let power = 1;

  while (power < value) power <<= 1;

  return power;
}

async function composePage(
  rects: PackedRect[],
  width: number,
  height: number,
): Promise<Buffer> {
  const composite = await Promise.all(
    rects.map(async (rect) => ({
      // `rotate:90` is stored counter-clockwise, so the source turns the other
      // way to land on the page in that orientation.
      input: rect.rot
        ? await sharp(rect.buffer).rotate(-90).png().toBuffer()
        : rect.buffer,
      left: rect.x,
      top: rect.y,
    })),
  );

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composite)
    .png()
    .toBuffer();
}

function serializePage(
  pageName: string,
  width: number,
  height: number,
  rects: PackedRect[],
): string {
  const lines = [pageName, `size:${width},${height}`, "filter:Linear,Linear"];

  for (const rect of rects) {
    // A region name is read as a raw line, so a colon in it would be parsed as
    // one of the key:value fields instead and the region silently lost.
    if (rect.name.includes(":")) {
      throw new Error(
        `[spine-packer] Region name "${rect.name}" contains ':', which a Spine atlas cannot represent. Rename the image.`,
      );
    }

    // `bounds` stays in the region's own orientation — a `rotate:90` region
    // occupies height × width on the page.
    lines.push(
      rect.name,
      `bounds:${rect.x},${rect.y},${rect.width},${rect.height}`,
    );

    if (rect.trimmed) {
      // `offsets` measures Y from the bottom: Spine's local space is Y-up (see
      // `RegionAttachment.computeUVs`, which builds `localY` upward from the
      // bottom edge).
      const offsetY = Math.max(
        0,
        rect.originalHeight - rect.trimTop - rect.height,
      );

      lines.push(
        `offsets:${rect.trimLeft},${offsetY},${rect.originalWidth},${rect.originalHeight}`,
      );
    }

    if (rect.rot) lines.push("rotate:90");
  }

  return `${lines.join("\n")}\n`;
}
