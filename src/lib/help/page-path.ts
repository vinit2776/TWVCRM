// Groups a real route like "/procurement/bills/4f1e...-a2b3" into
// "/procurement/bills/:id" so analytics can count "which page" without
// fragmenting across every individual record's path.
const ID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^\d+$/i;

export function normalizePagePath(path: string): string {
  const withoutQuery = path.split("?")[0];
  const segments = withoutQuery.split("/").map((segment) => (ID_SEGMENT.test(segment) ? ":id" : segment));
  const normalized = segments.join("/");
  return normalized || "/";
}
