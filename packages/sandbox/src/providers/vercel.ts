import type { SandboxLike } from "../types";
import { VERCEL_SANDBOX_RUNTIME, VERCEL_SANDBOX_TIMEOUT_MS } from "../config";
import { shellEscape, toErrorMessage } from "../internal/utils";

type VercelCommandResultLike = {
  exitCode: number | null;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
};

type VercelSandboxLike = {
  runCommand: (
    command: string,
    args?: string[],
  ) => Promise<VercelCommandResultLike>;
  readFileToBuffer: (file: {
    path: string;
    cwd?: string;
  }) => Promise<Buffer | null>;
  stop: () => Promise<void>;
};

type VercelSandboxCtor = {
  create: (opts?: {
    runtime?: string;
    timeout?: number;
  }) => Promise<VercelSandboxLike>;
};

async function loadSandboxCtor(): Promise<VercelSandboxCtor> {
  try {
    const specifier = "@vercel/sandbox";
    const mod = (await import(specifier)) as { Sandbox?: VercelSandboxCtor };
    if (!mod.Sandbox) {
      throw new Error("Sandbox export is not available");
    }
    return mod.Sandbox;
  } catch (error) {
    throw new Error(
      `Failed to load @vercel/sandbox. Install and configure it. ${toErrorMessage(error)}`,
    );
  }
}

export async function createVercelSandbox(): Promise<SandboxLike> {
  const Sandbox = await loadSandboxCtor();
  const sandbox = await Sandbox.create({
    runtime: VERCEL_SANDBOX_RUNTIME,
    timeout: VERCEL_SANDBOX_TIMEOUT_MS,
  });

  return {
    async runCommand(command: string, args: string[] = [], cwd?: string) {
      const script = cwd
        ? `cd ${shellEscape(cwd)} && ${[command, ...args].map(shellEscape).join(" ")}`
        : [command, ...args].map(shellEscape).join(" ");
      const result = await sandbox.runCommand("sh", ["-lc", script]);
      const [stdout, stderr] = await Promise.all([
        result.stdout(),
        result.stderr(),
      ]);
      return {
        stdout,
        stderr,
        exitCode: result.exitCode ?? 1,
      };
    },
    readFileToBuffer: sandbox.readFileToBuffer.bind(sandbox),
    stop: sandbox.stop.bind(sandbox),
  };
}
