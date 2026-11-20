import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-[20px] font-bold">This page does not exist</h1>
      <p className="hint">The staircase is on the front page.</p>
      <Link href="/" className="btn btn-primary">
        Back to the staircase
      </Link>
    </main>
  );
}
