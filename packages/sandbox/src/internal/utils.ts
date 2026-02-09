import type { SandboxGrepMatch } from "../types";

export function shellEscape(input: string): string {
  return `'${input.replaceAll("'", `'\"'\"'`)}'`;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function normalizeSearchPath(input: string): string {
  return input
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

export function filterBySearchPaths(
  paths: string[],
  searchPaths: string[] | null | undefined,
): string[] {
  if (!searchPaths || searchPaths.length === 0) {
    return paths;
  }

  const normalizedSearchPaths = searchPaths
    .map((searchPath) => normalizeSearchPath(searchPath))
    .filter((searchPath) => searchPath.length > 0);

  if (normalizedSearchPaths.length === 0) {
    return paths;
  }

  return paths.filter((filepath) => {
    const normalizedFilepath = normalizeSearchPath(filepath);
    return normalizedSearchPaths.some(
      (prefix) =>
        normalizedFilepath === prefix ||
        normalizedFilepath.startsWith(`${prefix}/`),
    );
  });
}

export function normalizeScopedPaths(paths?: string[] | null): string[] {
  if (!paths || paths.length === 0) {
    return [];
  }

  return paths
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path) => {
      if (path.startsWith("/")) {
        return path;
      }
      return normalizeSearchPath(path);
    });
}

export function parseRipgrepJson(stdout: string): SandboxGrepMatch[] {
  const matches: SandboxGrepMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
          submatches?: Array<{
            match?: { text?: string };
            start?: number;
            end?: number;
          }>;
        };
      };

      if (parsed.type !== "match" || !parsed.data?.path?.text) {
        continue;
      }

      matches.push({
        filepath: normalizeSearchPath(parsed.data.path.text),
        line: parsed.data.line_number ?? 0,
        text: parsed.data.lines?.text ?? "",
        submatches: (parsed.data.submatches ?? []).map((sub) => ({
          match: sub.match?.text ?? "",
          start: sub.start ?? 0,
          end: sub.end ?? 0,
        })),
      });
    } catch {
      // Ignore malformed lines from tool output.
    }
  }
  return matches;
}
