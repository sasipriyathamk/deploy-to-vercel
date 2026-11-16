import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Paper Trading Research",
};

export default function PaperLayout({ children }: { children: React.ReactNode }) {
  return children;
}
