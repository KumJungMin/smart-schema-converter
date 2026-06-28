export type PathSegment = string | number;

export function parsePath(path: string): PathSegment[] {
  if (!path) return [];

  return path.split(".").map((segment) => {
    if (/^(0|[1-9]\d*)$/.test(segment)) return Number(segment);
    return segment;
  });
}

export function getByPath(value: unknown, path: string): unknown {
  let current = value as any;

  for (const segment of parsePath(path)) {
    if (current == null) return undefined;
    current = current[segment as any];
  }

  return current;
}

export function emitPathAccess(root: string, path: string): string {
  return parsePath(path).reduce<string>((expr, segment) => {
    if (typeof segment === "number") return `${expr}[${segment}]`;
    return `${expr}[${JSON.stringify(segment)}]`;
  }, root);
}

export function emitSafePathAccess(root: string, path: string): string {
  return parsePath(path).reduce<string>((expr, segment) => {
    if (typeof segment === "number") return `${expr}?.[${segment}]`;
    return `${expr}?.[${JSON.stringify(segment)}]`;
  }, root);
}

export function emitPropertyAccess(root: string, property: string | number): string {
  if (typeof property === "number") return `${root}[${property}]`;
  if (/^[A-Za-z_$][\w$]*$/.test(property)) return `${root}.${property}`;
  return `${root}[${JSON.stringify(property)}]`;
}
