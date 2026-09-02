"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Inbox,
  Target,
  Wallet,
  RefreshCw,
  TrendingUp,
  List,
  BarChart3,
  Bot,
  Sparkles,
  ScrollText,
  MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/queue", label: "Approval Queue", icon: Inbox },
  { href: "/goals", label: "Goals", icon: Target },
  { href: "/budget", label: "Budget", icon: Wallet },
  { href: "/recurring", label: "Recurring", icon: RefreshCw },
  { href: "/invest", label: "Investments", icon: TrendingUp },
  { href: "/transactions", label: "Transactions", icon: List },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/agent", label: "Agent", icon: Bot },
  { href: "/self", label: "Self Improvement", icon: Sparkles },
  { href: "/audit", label: "Audit", icon: ScrollText },
];

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active =
          href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
