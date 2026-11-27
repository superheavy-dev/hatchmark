export async function load(): Promise<unknown> {
  // biome-ignore lint/style/useNodejsImportProtocol: the purity guard must catch bare built-in names
  return import("fs");
}
