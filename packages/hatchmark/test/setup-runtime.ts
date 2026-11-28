import { build } from "vite";

export default async function setup(): Promise<void> {
  const root = new URL("..", import.meta.url).pathname;
  await build({ root, configFile: `${root}vite.config.ts` });
  await build({ root, configFile: `${root}vite.config.ts`, mode: "periods" });
}
