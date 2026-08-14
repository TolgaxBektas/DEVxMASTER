import { LogOut, Menu, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "./components.js";

type AppNavEntry = {
  id: string;
  label: string;
  href: string;
  moduleId: string;
  moduleTitle: string;
};

export function AppShell({
  navigation,
  user,
  onLogout,
  children,
}: {
  navigation: AppNavEntry[];
  user: string;
  onLogout(): void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [location] = useLocation();
  const groups = navigation.reduce<Record<string, typeof navigation>>(
    (result, item) => {
      (result[item.moduleId] ??= []).push(item);
      return result;
    },
    {},
  );
  return (
    <div className="app-shell">
      <aside
        className={open ? "app-sidebar" : "app-sidebar app-sidebar-collapsed"}
      >
        <div className="brand">
          <ShieldCheck size={20} />
          <span>{open && "xMaster Center"}</span>
        </div>
        {Object.entries(groups).map(([moduleId, items]) => (
          <div className="nav-group" key={moduleId}>
            {open && <div className="nav-title">{items[0]?.moduleTitle}</div>}
            {items.map((item) => (
              <Link
                key={item.id}
                href={item.href}
                className={
                  location === item.href ? "nav-link active" : "nav-link"
                }
              >
                {open && item.label}
              </Link>
            ))}
          </div>
        ))}
        <div className="sidebar-footer">
          {open && <span>{user}</span>}
          <Button variant="ghost" onClick={onLogout} aria-label="Abmelden">
            <LogOut size={16} />
          </Button>
        </div>
      </aside>
      <main className="app-main">
        <header className="app-header">
          <Button
            variant="ghost"
            onClick={() => setOpen((value) => !value)}
            aria-label="Menü"
          >
            <Menu size={18} />
          </Button>
          <span className="header-caption">Mandantenzentrale</span>
        </header>
        <div className="page-content">{children}</div>
      </main>
    </div>
  );
}
