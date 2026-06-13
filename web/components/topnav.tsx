"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/components/auth";

const LINKS = [
  { href: "/dashboard", label: "Insights" },
  { href: "/team", label: "Team" },
  { href: "/history", label: "History" },
];

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { email, activeTeam, signOut } = useAuth();

  return (
    <header className="topbar">
      <Link href="/dashboard" className="brand">
        oh<span className="dot">.</span>
      </Link>
      <nav className="topnav">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={pathname.startsWith(l.href) ? "active" : ""}>
            {l.label}
          </Link>
        ))}
        <span className="who">
          {activeTeam ? `${activeTeam.team_name} · ` : ""}
          {email}
        </span>
        <a
          onClick={async () => {
            await signOut();
            router.replace("/login");
          }}
          style={{ cursor: "pointer" }}
        >
          sign out
        </a>
      </nav>
    </header>
  );
}
