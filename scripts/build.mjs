import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = path.join(projectRoot, "dist");
const storefrontDirectory = path.join(projectRoot, "frontend", "storefront");
const adminDirectory = path.join(projectRoot, "frontend", "admin");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(storefrontDirectory, outputDirectory, { recursive: true });
await cp(
  path.join(adminDirectory, "admin.html"),
  path.join(outputDirectory, "admin.html")
);
await cp(
  path.join(adminDirectory, "assets"),
  path.join(outputDirectory, "assets"),
  { recursive: true, force: true }
);
