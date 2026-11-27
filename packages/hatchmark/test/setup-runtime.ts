import { build } from "vite";

/** Builds the browser runtime once before the tests, as pnpm build does, since build copies it. */
export default async function setup(): Promise<void> {
  const root = new URL("..", import.meta.url).pathname;
  await build({ root, configFile: `${root}vite.config.ts` });
}
