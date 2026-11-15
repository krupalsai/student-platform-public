"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useRoleGuard } from "@/lib/hooks/useRoleGuard";

const PUBLIC_ADMIN_PATHS = ["/admin/login"];

/** Protects the admin area. Sensitive screens enforce their own Super Admin guard. */
export default function AdminRoleGuard() {
  const pathname = usePathname();
  if (PUBLIC_ADMIN_PATHS.includes(pathname ?? "")) return null;
  return <GuardedAdmin pathname={pathname ?? ""} />;
}

function GuardedAdmin({ pathname }: { pathname: string }) {
  const router = useRouter();
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("sp_token");
    if (!token) return;
    let active = true;
    fetch("/api/auth/session", { cache: "no-store", headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((j) => { if (active && j?.success && j?.data?.role) setRole(j.data.role as string); })
      .catch(() => {});
    return () => { active = false; };
  }, [pathname]);

  useEffect(() => {
    // Admin and Super Admin can enter the console. Students/other roles cannot.
    if (pathname === "/admin") return;
    if (role && !["admin", "super_admin"].includes(role)) router.replace("/admin");
  }, [role, pathname, router]);

  useRoleGuard("/admin");
  return null;
}
