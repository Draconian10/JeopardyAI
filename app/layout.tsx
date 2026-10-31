import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { Zap } from 'lucide-react';
import './globals.css';
export const metadata: Metadata = {
  title: 'Jeopardy Live',
  description: 'Host a custom Jeopardy game with live buzzers and real-time scores.',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#241634' };
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
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
