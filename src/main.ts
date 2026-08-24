import { SpineLayout } from "@pixijs-userland/spine-layout";
import { AppController } from "./controllers/App.controller";
import { RootLayout } from "./layout/Root.layout";

async function main() {
  const app = new AppController();

  await app.init();

  const spineLayout = new SpineLayout({ debug: true });

  spineLayout.createInstancesFromManifest(app.manifest, "spine");

  app.stage.addChild(new RootLayout(spineLayout));
}

void main();
