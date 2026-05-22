import "./globals.css";
import type { Metadata } from "next";
import { Sidebar } from "@/components/nav/sidebar";

export const metadata: Metadata = {
  title: "revenue-rec — ASC 606 engine",
  description:
    "AI-assisted ASC 606 revenue recognition on top of the ledger-core substrate.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 px-6 py-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
