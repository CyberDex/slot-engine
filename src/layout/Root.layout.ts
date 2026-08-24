import "@pixi/layout";
import { Layout } from "@pixi/layout";
import { SpineLayout } from "@pixijs-userland/spine-layout";

/**
 * Design size of the scene, in spine units, centred on the scene's own origin.
 * The layout runs at 1:1 while the viewport is at least this big, and scales
 * down — never up — once either side drops below it.
 */
const DESIGN_WIDTH = 1080;
const DESIGN_HEIGHT = 900;

export class RootLayout extends Layout {
  constructor(spineLayout: SpineLayout = new SpineLayout()) {
    super({
      id: "root",
      styles: {
        width: "100%",
        height: "100%",
      },
      content: {
        id: "scene",
        content: spineLayout,
        styles: {
          // A spine scene is authored around its own origin, so the design box
          // is anchored on the box origin rather than on its top-left corner —
          // that is what `anchorX`/`anchorY: 0` do here: together with
          // `position: center` they drop the scene origin, and with it the
          // middle of the design area, exactly in the middle of the viewport.
          position: "center",
          anchorX: 0,
          anchorY: 0,
          width: DESIGN_WIDTH,
          height: DESIGN_HEIGHT,
          // Anything the scene draws outside the design box (the background is
          // authored well past it) simply bleeds out — it is never measured, so
          // it never pulls the scale down.
          maxWidth: "100%",
          maxHeight: "100%",
        },
      },
    });

    window.addEventListener("resize", () => this.onResize());
    this.onResize();
  }

  private onResize() {
    this.resize(window.innerWidth, window.innerHeight);
  }
}
