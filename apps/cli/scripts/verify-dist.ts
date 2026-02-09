// https://github.com/davis7dotsh/better-context/blob/main/apps/cli/scripts/verify-dist.ts

const requiredFiles = [
  "ctxpack-darwin-arm64",
  "ctxpack-darwin-x64",
  "ctxpack-linux-x64",
  "ctxpack-linux-arm64",
  "ctxpack-windows-x64.exe",
];

const distDir = new URL("../dist/", import.meta.url);
const missing = [] as string[];

for (const file of requiredFiles) {
  const fileUrl = new URL(file, distDir);
  const exists = await Bun.file(fileUrl).exists();
  if (!exists) {
    missing.push(file);
  }
}

if (missing.length) {
  console.error("[ctxpack] Missing required dist artifacts:");
  for (const file of missing) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

const packageJsonUrl = new URL("../package.json", import.meta.url);
const packageJson = (await Bun.file(packageJsonUrl).json()) as {
  dependencies?: Record<string, string>;
};
const workspaceRuntimeDeps = Object.entries(packageJson.dependencies ?? {})
  .filter(([, version]) => version.startsWith("workspace:"))
  .map(([name, version]) => `${name}@${version}`);

if (workspaceRuntimeDeps.length > 0) {
  console.error(
    "[ctxpack] Runtime dependencies cannot use workspace protocol in published package:",
  );
  for (const dep of workspaceRuntimeDeps) {
    console.error(`- ${dep}`);
  }
  process.exit(1);
}

console.log("[ctxpack] All required dist artifacts are present.");
