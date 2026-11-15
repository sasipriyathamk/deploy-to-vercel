"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

export type NavTab = "watching" | "alerts";

type TabCounts = {
  watching?: number;
};

type NavContextValue = {
  activeTab: NavTab;
  setActiveTab: (tab: NavTab) => void;
  tabCounts: TabCounts;
  setTabCounts: (counts: TabCounts) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
};

const NavContext = createContext<NavContextValue | null>(null);

export function NavProvider({ children }: { children: ReactNode }) {
  const [activeTab, setActiveTab] = useState<NavTab>("watching");
  const [tabCounts, setTabCounts] = useState<TabCounts>({});
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <NavContext.Provider
      value={{
        activeTab,
        setActiveTab,
        tabCounts,
        setTabCounts,
        settingsOpen,
        setSettingsOpen,
      }}
    >
      {children}
    </NavContext.Provider>
  );
}

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext);
  if (!ctx) {
    throw new Error("useNav must be used within a NavProvider");
  }
  return ctx;
}
