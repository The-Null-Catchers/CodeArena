import "./globals.css";
import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "CodeArena • Execution infrastructure",
  description:
    "Run untrusted code safely, with isolated sandboxes and distributed workers.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
