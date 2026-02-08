import { getSandboxProvider } from "../config";
import type { SandboxLike } from "../types";
import { createDaytonaSandbox } from "./daytona";
import { createVercelSandbox } from "./vercel";

export async function createSandbox(): Promise<SandboxLike> {
  const provider = getSandboxProvider();
  if (provider === "daytona") {
    return createDaytonaSandbox();
  }
  return createVercelSandbox();
}

