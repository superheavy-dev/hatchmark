export type PointerSegment = string | number;

function escapeSegment(segment: PointerSegment): string {
  return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Encodes path segments as an RFC 6901 JSON Pointer. The empty path is the root, "". */
export function toPointer(segments: readonly PointerSegment[]): string {
  return segments.map((segment) => `/${escapeSegment(segment)}`).join("");
}

/** Decodes an RFC 6901 JSON Pointer into its unescaped reference tokens. */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/"))
    throw new Error(`invalid JSON Pointer "${pointer}": must start with "/"`);
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}
