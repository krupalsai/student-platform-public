import AdminHeartbeat from "@/components/admin/AdminHeartbeat";
import AdminRoleGuard from "@/components/admin/AdminRoleGuard";
import AdminNavDrawer from "@/components/admin/AdminNavDrawer";
import IncomingCallWatcher from "@/components/admin/IncomingCallWatcher";

export const metadata = {
  title: "Student Platform Admin",
  description: "Student Platform administration dashboard",
  manifest: "/admin-manifest.webmanifest",
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AdminRoleGuard />
      <AdminHeartbeat />
      {children}
      <AdminNavDrawer />
      <IncomingCallWatcher />
    </>
  );
}
