import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="fixed inset-0 w-screen h-[100dvh] flex flex-col items-center justify-center gap-6 bg-white dark:bg-black text-neutral-950 dark:text-white select-none">
      <p className="text-xs tracking-[0.2em] font-[family-name:var(--font-mono)] text-neutral-950/60 dark:text-white/60">
        404 · NOT FOUND
      </p>
      <Link
        href="/"
        className="min-h-[44px] px-4 flex items-center justify-center border border-neutral-950/25 dark:border-white/25 text-[11px] tracking-[0.16em] font-[family-name:var(--font-mono)] text-neutral-950/80 dark:text-white/80 hover:text-neutral-950 dark:hover:text-white hover:border-neutral-950/60 dark:hover:border-white/60 transition-colors"
      >
        RETURN TO STUDIO
      </Link>
    </main>
  );
}
