import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const THEME_MODE_STORAGE_KEY = "viba:theme-mode";
const themeBootstrapScript = `
(() => {
  try {
    const stored = window.localStorage.getItem('${THEME_MODE_STORAGE_KEY}');
    const mode = stored === 'light' || stored === 'dark' || stored === 'auto' ? stored : 'auto';
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const shouldUseDark = mode === 'dark' || (mode === 'auto' && prefersDark);

    document.documentElement.classList.toggle('dark', shouldUseDark);
    document.documentElement.dataset.themeMode = mode;
  } catch {
    document.documentElement.classList.remove('dark');
    document.documentElement.dataset.themeMode = 'auto';
  }
})();
`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Viba",
    template: "%s | Viba",
  },
  icons: {
    icon: "/icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: themeBootstrapScript,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
