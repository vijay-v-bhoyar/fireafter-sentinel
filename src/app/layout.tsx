import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FireAfter Sentinel | Evidence-bound inspection review",
  description:
    "Source-linked evidence review, inspection proposals and retained human decisions for post-wildfire response.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
