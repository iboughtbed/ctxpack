import {
  DAYTONA_SANDBOX_TIMEOUT_SECONDS,
  parseBoolean,
  parseNumber,
} from "../config";
import { shellEscape, toErrorMessage } from "../internal/utils";
import type { SandboxLike } from "../types";

type DaytonaProcessResponse = {
  exitCode?: number | null;
  result?: string | null;
  stdout?: string | null;
  stderr?: string | null;
};

type DaytonaSandboxLike = {
  process: {
    executeCommand: (
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ) => Promise<DaytonaProcessResponse>;
  };
  fs: {
    downloadFile: (
      remotePath: string,
      timeout?: number,
    ) => Promise<Buffer | Uint8Array | ArrayBuffer | string>;
  };
  delete: (timeout?: number) => Promise<void>;
};

type DaytonaClientLike = {
  create: (
    params?: Record<string, unknown>,
    options?: { timeout?: number },
  ) => Promise<DaytonaSandboxLike>;
};

type DaytonaCtor = new (config?: Record<string, unknown>) => DaytonaClientLike;

type DaytonaModuleLike = {
  Daytona?: DaytonaCtor;
};

function toBuffer(
  value: Buffer | Uint8Array | ArrayBuffer | string,
): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(value));
  }
  return Buffer.from(value);
}

function maybeParseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function loadDaytonaCtor(): Promise<DaytonaCtor> {
  try {
    const specifier = "@daytonaio/sdk";
    const mod = (await import(specifier)) as DaytonaModuleLike;
    if (!mod.Daytona) {
      throw new Error("Daytona export is not available");
    }
    return mod.Daytona;
  } catch (error) {
    throw new Error(
      `Failed to load @daytonaio/sdk. Install it to enable Daytona provider. ${toErrorMessage(error)}`,
    );
  }
}

function buildDaytonaConfig(): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (process.env.DAYTONA_API_KEY) {
    config.apiKey = process.env.DAYTONA_API_KEY;
  }
  if (process.env.DAYTONA_API_URL) {
    config.apiUrl = process.env.DAYTONA_API_URL;
  }
  if (process.env.DAYTONA_TARGET) {
    config.target = process.env.DAYTONA_TARGET;
  }
  if (process.env.DAYTONA_JWT_TOKEN) {
    config.jwtToken = process.env.DAYTONA_JWT_TOKEN;
  }
  if (process.env.DAYTONA_ORGANIZATION_ID) {
    config.organizationId = process.env.DAYTONA_ORGANIZATION_ID;
  }
  return config;
}

function buildCreateParams(): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (process.env.DAYTONA_SANDBOX_LANGUAGE) {
    params.language = process.env.DAYTONA_SANDBOX_LANGUAGE;
  }
  if (process.env.DAYTONA_SANDBOX_NAME_PREFIX) {
    params.name = `${process.env.DAYTONA_SANDBOX_NAME_PREFIX}-${crypto.randomUUID()}`;
  }

  if (process.env.DAYTONA_SANDBOX_EPHEMERAL) {
    params.ephemeral = parseBoolean(process.env.DAYTONA_SANDBOX_EPHEMERAL, true);
  }

  const autoStopInterval = maybeParseNumber(
    process.env.DAYTONA_SANDBOX_AUTOSTOP_INTERVAL,
  );
  if (typeof autoStopInterval === "number") {
    params.autoStopInterval = autoStopInterval;
  }

  const autoArchiveInterval = maybeParseNumber(
    process.env.DAYTONA_SANDBOX_AUTOARCHIVE_INTERVAL,
  );
  if (typeof autoArchiveInterval === "number") {
    params.autoArchiveInterval = autoArchiveInterval;
  }

  const autoDeleteInterval = maybeParseNumber(
    process.env.DAYTONA_SANDBOX_AUTODELETE_INTERVAL,
  );
  if (typeof autoDeleteInterval === "number") {
    params.autoDeleteInterval = autoDeleteInterval;
  }

  return params;
}

export async function createDaytonaSandbox(): Promise<SandboxLike> {
  const Daytona = await loadDaytonaCtor();
  const daytona = new Daytona(buildDaytonaConfig());
  const createParams = buildCreateParams();
  const sandbox = await daytona.create(
    Object.keys(createParams).length > 0 ? createParams : undefined,
    {
      timeout: parseNumber(
        process.env.DAYTONA_SANDBOX_CREATE_TIMEOUT_SECONDS,
        DAYTONA_SANDBOX_TIMEOUT_SECONDS,
      ),
    },
  );

  return {
    async runCommand(command: string, args: string[] = [], cwd?: string) {
      const executable = [command, ...args].map(shellEscape).join(" ");
      const response = await sandbox.process.executeCommand(
        `sh -lc ${shellEscape(executable)}`,
        cwd,
        undefined,
        parseNumber(
          process.env.DAYTONA_SANDBOX_COMMAND_TIMEOUT_SECONDS,
          DAYTONA_SANDBOX_TIMEOUT_SECONDS,
        ),
      );

      const stdout = String(response.stdout ?? response.result ?? "");
      const stderr = String(response.stderr ?? "");
      const exitCode =
        typeof response.exitCode === "number" && Number.isFinite(response.exitCode)
          ? response.exitCode
          : 0;

      return {
        stdout,
        stderr,
        exitCode,
      };
    },
    async readFileToBuffer(file: { path: string }) {
      try {
        const content = await sandbox.fs.downloadFile(file.path);
        return toBuffer(content);
      } catch (error) {
        const message = toErrorMessage(error).toLowerCase();
        if (
          message.includes("not found") ||
          message.includes("no such file") ||
          message.includes("enoent")
        ) {
          return null;
        }
        throw error;
      }
    },
    async stop() {
      await sandbox.delete(
        parseNumber(
          process.env.DAYTONA_SANDBOX_DELETE_TIMEOUT_SECONDS,
          DAYTONA_SANDBOX_TIMEOUT_SECONDS,
        ),
      );
    },
  };
}

