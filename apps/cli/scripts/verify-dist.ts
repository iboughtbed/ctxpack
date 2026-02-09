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

console.log("[ctxpack] All required dist artifacts are present.");
