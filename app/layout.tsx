import type { Metadata, Viewport } from 'next';
import { Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
  ],
};

export const metadata: Metadata = {
  title: 'Risset Lab — Endless Rhythm Illusion Studio',
  description:
    "Interactive auditory illusion studio exploring the Risset rhythm (the Shepard tone of tempo) and the four psychoacoustic techniques behind the endless acceleration in 'The Odyssey' soundtrack.",
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Risset',
  },
  openGraph: {
    title: 'Risset Lab — Endless Rhythm Illusion Studio',
    description:
      "Interactive auditory illusion studio exploring the Risset rhythm (the Shepard tone of tempo) and the four psychoacoustic techniques behind the endless acceleration in 'The Odyssey' soundtrack.",
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Risset Lab — Endless Rhythm Illusion Studio',
    description:
      "Interactive auditory illusion studio exploring the Risset rhythm (the Shepard tone of tempo) and the four psychoacoustic techniques behind the endless acceleration in 'The Odyssey' soundtrack.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${plusJakarta.variable} ${jetbrainsMono.variable}`}
    >
      <body
        suppressHydrationWarning
        className="fixed inset-0 w-screen h-[100dvh] overflow-hidden bg-white dark:bg-black text-neutral-950 dark:text-white antialiased selection:bg-neutral-950 selection:text-white dark:selection:bg-white dark:selection:text-black font-[family-name:var(--font-display)]"
      >
        {children}
      </body>
    </html>
  );
}
