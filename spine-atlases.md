# How Spine atlases get packed in the build

`slot-reel-of-the-dead` commits Spine's **raw** export — a skeleton `.json` plus a folder of
loose `.png`s — and the build packs the atlas. Nobody re-exports a packed atlas by hand when
the art changes, and no `.atlas` or packed page is ever committed.

The packing is an AssetPack pipe, and AssetPack runs as a Vite plugin, so it happens on
`pnpm dev` and on `vite build` alike, before Rollup sees anything.

## In and out

Committed, in [apps/slot-reel-of-the-dead/assets/](../apps/slot-reel-of-the-dead/assets/):

```
assets/spine/
├─ bg.json  symbol.json  reels.json  …     9 skeletons, exported as "JSON only, no packing"
├─ bg.spine symbol.spine …                 Spine project files (never shipped)
└─ img/**.png                              89 loose images, shared by all 9 (never shipped)
   ├─ symbols/…
   └─ bigWin/…
```

Produced into `.assetpack/output/assets/spine/` (gitignored, and Vite's `publicDir`):

```
assets/spine/
├─ bg.json      bg.atlas      bg.png  bg-1.png  bg-2.png  bg-3.png
├─ symbol.json  symbol.atlas  symbol.png
└─ … plus a @0.7x .atlas and page(s) for each
```

One atlas per skeleton — `symbol.atlas` holds the 49 regions `symbol.json` references and
nothing else, even though it shares `img/` with the other eight. Images used by two skeletons
are packed into both, exactly as a per-skeleton Spine export would do. A skeleton that does
not fit one page spills onto `-1`, `-2`, … and logs a warning; `bg` currently takes four
pages, so that warning on every build is expected, not a regression.

## Where it is wired up

Everything is in [vite.config.ts](../apps/slot-reel-of-the-dead/vite.config.ts) →
`assetpackPlugin()`. It constructs one `AssetPack` over `./assets` and runs it from
`buildStart`: `ap.watch()` under `vite dev`, a single `run()` for a build.

Two pipes come from [`@magic/assetpack`](../packages/magic-assetpack/):

| Pipe                     | Where in the list                  | What it does                                                                 |
| ------------------------ | ---------------------------------- | ---------------------------------------------------------------------------- |
| `spinePacker`            | **before** `json()` and `mipmap()` | Claims each skeleton and emits `.json` + `.atlas` + page(s) in its place     |
| `spinePackerManifestMod` | **after** `pixiManifest()`         | Splits the skeleton's one manifest entry into the trio the runtime looks for |

The order is load-bearing. `spinePacker` has to claim the skeleton before `json()` gets it and
before `mipmap()` starts laddering the loose source images — which are consumed by the pipe and
so never reach the output or the manifest. `spinePackerManifestMod` patches a manifest that
`pixiManifest` has already written.

Between them the generated files go through the same pipes as everything else: `mipmap` skips
the pages (the packer stamps `nomip` on them — they are already at their final size), `compress`
is off for all but the launch screen, and then `cacheBuster()` + `spineAtlasCacheBuster()` hash
the filenames and rewrite the page name inside the `.atlas` to match.

Dev and build differ in one way that matters when reading output: `assetpackPlugin(isDevMode)`
turns AssetPack's cache **on** for `--mode development` and drops the four cache busters, so a
dev build has clean names (`spine/bg.atlas`) and a production build has hashed ones
(`spine/bg-E-Y7Og.atlas`).

## The rules the packer follows

Enough to predict what it will do; [packages/magic-assetpack/README.md](../packages/magic-assetpack/README.md)
has the reasoning and the atlas-format details.

- **What counts as a skeleton.** A `.json` with **no sibling `.atlas`** and an image folder next
  to it. Both pipes are no-ops for a game that commits a packed export, so they are safe to
  leave wired up everywhere.
- **Which images belong to it.** A folder named after the skeleton (`symbol.json` → `symbol/`)
  or an `img` / `images` / `pictures` folder beside it, shared by every skeleton in that folder.
  This game uses the shared `img/`.
- **Region names** are the path relative to the image folder, or the bare filename when the
  skeleton asks for it that way — Spine's own packer can flatten subfolders, so `symbol.json`
  says `H1_blur` for `img/symbols/H1_blur.png`.
- **Only referenced regions are packed.** A region the skeleton names with no image behind it is
  a warning; two images claiming one region name is a `BuildReporter.error`, which stops a strict
  build.
- **Meshes are packed untrimmed.** `MeshAttachment` lays its UVs over the region's _original_
  rectangle, so a trimmed border still gets sampled — on a packed page that is whatever landed
  next door. Anything a `mesh` or `linkedmesh` reaches keeps its full size; everything else is
  trimmed.
- **Watch mode.** AssetPack only re-transforms what changed, so `spinePacker.start` marks the
  owning skeleton modified when one of its images changes — otherwise editing a `.png` would
  leave the atlas stale.

## Two sizes of everything

`RESOLUTIONS` in the game's config is `{ default: 1, low: 0.7 }`, shared by `spinePacker`,
`texturePacker` and `mipmap` so all three ladder the same way.

The regions are trimmed and packed **once**, at full size, and the smaller rung reuses that
layout with every coordinate multiplied through. So both rungs have the same page count under
the same names — `symbol.png` is 1292×1246 and `symbol@0.7x.png` is 905×872 — which is what lets
the manifest pair them up. Regions are resized individually, never by shrinking the finished
page, which would drag each sprite's neighbours in over its edges.

The **skeleton is emitted once**, unsuffixed and byte-identical to what was exported: a rung
changes how many texels a region is stored in, and Spine reads drawn size off the attachment and
texel size off the atlas.

`spinePackerManifestMod` then puts the two rungs of one file into a single manifest entry as two
`src`s under one resolution-stripped alias, full size first (`srcSortOptions: fullSizeFirst`) —
two entries would make the bundle load both. Which rung a device gets is decided at runtime in
[textures.config.ts](../packages/magic-slot/src/config/textures.config.ts): handhelds are served
`[0.7, 1]`, everything else full size, and `?textures=0.7` forces it for a side-by-side.

## How the runtime finds them

Nothing names a spine explicitly. `findSpineBundles` picks the bundles holding a `.atlas` and
takes the folder prefix off the alias, then `ManifestParser.getSpineAssets` pairs
`<id>.atlas` + `<id>.json` + `<id>.png` within each bundle and `SpineLayout` builds a
`Spine.from({ skeleton, atlas })` per match, keyed by `<id>`.

That triple-match is why each skeleton needs its own atlas and its own first page, and why
`spinePackerManifestMod` has to split the entry at all. In this game `assets/spine/` carries no
`{m}` tag, so all of it lands in the `default` bundle — an untagged folder is fine, the runtime
scans every bundle.

## When something looks wrong

- **Read the build log.** The packer logs a line per skeleton (`symbol: packed 49 images`,
  with the rungs it packed them at), and its warnings and errors go through `BuildReporter`.
  A pipe that throws instead is swallowed by AssetPack as "Transform failed" with exit 0 — a
  missing skeleton in `dist` with a green build is the signature.
- **Look at the output, not the source.** `.assetpack/output/assets/` is the whole answer:
  the `.atlas` is plain text, and `removeFolderPlugin('./.assetpack')` wipes it at `buildStart`,
  so what is there is from this run.
- **Geometry changes want re-verifying.** After touching `packSpineAtlas`, reconstruct regions
  from the generated page using only atlas metadata and compare against the sources — the
  round-trip is described in the package README, along with the two conventions that are easy to
  get backwards (`rotate:90` is counter-clockwise, `offsets` measures Y from the bottom).
