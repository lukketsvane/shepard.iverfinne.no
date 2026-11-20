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

// Pinch zoom stays on, for anyone who needs the text larger. Accidental zooms are kept off the
// instrument itself: touch-action on the page and on the staircase, and no gesture zoom there.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1013' },
  ],
};

const TITLE = 'Endless staircase: Risset rhythm and Shepard tone';
const DESCRIPTION =
  'A rhythm that speeds up forever and a tone that rises forever, and the trick behind both. Play it, steer it by tilting your phone, edit the groove, and save a loop that repeats without a seam.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Staircase',
  },
  openGraph: { title: TITLE, description: DESCRIPTION, type: 'website' },
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plusJakarta.variable} ${jetbrainsMono.variable}`}>
      <body suppressHydrationWarning className="antialiased">
        {children}
      </body>
    </html>
  );
}
