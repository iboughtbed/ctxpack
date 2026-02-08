type OptionValue = boolean | string | string[];

export type ParsedArgv = {
  command: string | null;
  subcommand: string | null;
  positionals: string[];
  options: Record<string, OptionValue>;
};

function appendOption(
  options: Record<string, OptionValue>,
  key: string,
  value: boolean | string,
): void {
  const existing = options[key];
  if (existing === undefined) {
    options[key] = value;
    return;
  }

  if (Array.isArray(existing)) {
    existing.push(String(value));
    options[key] = existing;
    return;
  }

  options[key] = [String(existing), String(value)];
}

export function parseArgv(argv: string[]): ParsedArgv {
  const tokens = [...argv];
  let command: string | null = null;
  let subcommand: string | null = null;

  if (tokens[0] && !tokens[0].startsWith("-")) {
    command = tokens.shift() ?? null;
  }

  if (command === "remote" && tokens[0] && !tokens[0].startsWith("-")) {
    subcommand = tokens.shift() ?? null;
  }

  const options: Record<string, OptionValue> = {};
  const positionals: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    if (token.startsWith("--")) {
      const raw = token.slice(2);
      const eqIndex = raw.indexOf("=");
      if (eqIndex >= 0) {
        const key = raw.slice(0, eqIndex);
        const value = raw.slice(eqIndex + 1);
        appendOption(options, key, value);
        continue;
      }

      const key = raw;
      const next = tokens[index + 1];
      if (next && !next.startsWith("-")) {
        appendOption(options, key, next);
        index += 1;
      } else {
        appendOption(options, key, true);
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const short = token.slice(1);
      if (short.length > 1) {
        for (const char of short) {
          appendOption(options, char, true);
        }
        continue;
      }

      const key = short;
      const next = tokens[index + 1];
      if (next && !next.startsWith("-")) {
        appendOption(options, key, next);
        index += 1;
      } else {
        appendOption(options, key, true);
      }
      continue;
    }

    positionals.push(token);
  }

  return {
    command,
    subcommand,
    positionals,
    options,
  };
}

function readOption(
  options: Record<string, OptionValue>,
  names: string[],
): OptionValue | undefined {
  for (const name of names) {
    const value = options[name];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function getOptionString(
  options: Record<string, OptionValue>,
  names: string[],
): string | undefined {
  const value = readOption(options, names);
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value.length > 0) {
    const last = value[value.length - 1];
    return typeof last === "string" ? last : undefined;
  }

  return undefined;
}

export function getOptionBoolean(
  options: Record<string, OptionValue>,
  names: string[],
): boolean {
  const value = readOption(options, names);
  if (value === undefined) {
    return false;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    if (!last) {
      return true;
    }
    const normalized = last.toLowerCase();
    return !["false", "0", "no", "off"].includes(normalized);
  }

  const normalized = value.toLowerCase();
  return !["false", "0", "no", "off"].includes(normalized);
}

export function getOptionNumber(
  options: Record<string, OptionValue>,
  names: string[],
): number | undefined {
  const raw = getOptionString(options, names);
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

export function getOptionArray(
  options: Record<string, OptionValue>,
  names: string[],
): string[] {
  const value = readOption(options, names);
  if (value === undefined) {
    return [];
  }

  const parts: string[] = [];
  const pushParts = (raw: string) => {
    for (const item of raw.split(",")) {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
    }
  };

  if (typeof value === "string") {
    pushParts(value);
    return parts;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      pushParts(item);
    }
    return parts;
  }

  return [];
}
