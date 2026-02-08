export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-black px-6 text-white">
      <div className="flex w-full max-w-xl flex-col items-center gap-6 text-center font-mono">
        <code className="rounded-md border border-white/20 bg-white/5 px-4 py-3 text-sm sm:text-base">
          bun i -g ctxpack@latest
        </code>

        <div className="flex items-center gap-6 text-sm">
          <a
            href="https://github.com/iboughtbed/ctxpack"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-white/75"
          >
            <span>github</span>
          </a>
          <a
            href="https://docs.ctxpack.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-white/75"
          >
            <span>docs</span>
          </a>
        </div>
      </div>
    </main>
  );
}
