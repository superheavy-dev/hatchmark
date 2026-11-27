import { build } from "vite";

/** Builds the browser scripts once before the tests, as pnpm build does, since build copies them. */
export default async function setup(): Promise<void> {
  const root = new URL("..", import.meta.url).pathname;
  await build({ root, configFile: `${root}vite.config.ts` });
  await build({ root, configFile: `${root}vite.config.ts`, mode: "periods" });
}
