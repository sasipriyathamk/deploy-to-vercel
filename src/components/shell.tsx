"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import {
  Settings,
  Eye,
  ChartNoAxesCombined,
} from "lucide-react";
import { SearchBox } from "@/components/search-box";
import { SettingsDialog } from "@/components/settings-dialog";
import { useNav, type NavTab } from "@/components/nav-context";
export function Shell({ children }: { children: ReactNode }) {
  const { activeTab, setActiveTab, tabCounts, settingsOpen, setSettingsOpen } =
    useNav();
  const pathname = usePathname(),
    router = useRouter();
  function navigate(tab: NavTab) {
    setActiveTab(tab);
    if (pathname !== "/") router.push("/");
    else window.scrollTo({ top: 0, behavior: "smooth" });
  }
  const tabs = [
    {
      id: "watching" as const,
      label: "Watching",
      icon: Eye,
      count: tabCounts.watching,
    },
    {
      id: "alerts" as const,
      label: "Alert stats",
      icon: ChartNoAxesCombined,
      count: undefined,
    },
  ];
  const nav = tabs.map((t) => (
    <button
      key={t.id}
      aria-current={pathname === "/" && activeTab === t.id ? "page" : undefined}
      onClick={() => navigate(t.id)}
    >
      <t.icon size={19} />
      <span>{t.label}</span>
      {t.id !== "alerts" && <b>{t.count ?? "—"}</b>}
    </button>
  ));
  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link href="/" className="brand">
          Keel
        </Link>
        <nav aria-label="Main navigation" className="side-navigation">
          {nav}
        </nav>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <Link href="/" className="mobile-brand">
            Keel
          </Link>
          <div className="global-search">
            <SearchBox />
          </div>
          <button
            className="icon-control"
            aria-label="Open settings"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={18} />
          </button>
        </header>
        <main id="main-content" className="main-content">
          {children}
        </main>
      </div>
      <nav className="mobile-navigation" aria-label="Mobile navigation">
        {nav}
      </nav>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
