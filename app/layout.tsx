import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { Zap } from 'lucide-react';
import './globals.css';
export const metadata: Metadata = {
  title: 'Jeopardy Live · A little friendly competition',
  description: 'Build a board. Bring your people. Let the best buzzer win.',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#10182c' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            <span className="brand-icon">
              <Zap size={20} fill="currentColor" />
            </span>
            jeopardy<span className="brand-live">LIVE</span>
          </Link>
          <span className="header-note">GOOD COMPANY. GREAT COMPETITION.</span>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <span>Made for game night.</span>
          <span>Independent trivia game · Not affiliated with Jeopardy!</span>
        </footer>
      </body>
    </html>
  );
}
