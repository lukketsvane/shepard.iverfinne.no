'use client';

import { THEORY } from '@/lib/theory';

const MATH = '$math ';

/** "How it works": the sections of THEORY, with a list to jump between them. */
export default function TheoryPanel() {
  const jump = (id: string) =>
    document.getElementById(`theory-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="prose">
      <details className="mb-6 max-w-[38rem] rounded-xl border border-line bg-surface">
        <summary className="flex min-h-[44px] cursor-pointer items-center px-4 font-semibold">Jump to a section</summary>
        <nav aria-label="Sections" className="flex flex-col px-4 pb-2">
          {THEORY.map((section) => (
            <button
              key={section.id}
              type="button"
              className="min-h-[44px] text-left text-accent underline-offset-4 hover:underline"
              onClick={() => jump(section.id)}
            >
              {section.title}
            </button>
          ))}
        </nav>
      </details>
      {THEORY.map((section) => (
        <section key={section.id} id={`theory-${section.id}`} className="mb-8 scroll-mt-2">
          <h3 className="heading mb-3">{section.title}</h3>
          {section.body.map((paragraph, i) =>
            paragraph.startsWith(MATH) ? (
              <pre key={i} className="math">
                {paragraph.slice(MATH.length)}
              </pre>
            ) : (
              <p key={i}>{paragraph}</p>
            )
          )}
        </section>
      ))}
    </div>
  );
}
