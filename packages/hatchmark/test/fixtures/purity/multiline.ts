export async function probe() {
  return import(
    // The loader is only needed on this path.
    "node:fs/promises"
  );
}
