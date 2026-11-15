import InstallStudentAppBody from "@/components/pwa/InstallStudentAppBody";

export const metadata = {
  title: "Student App",
  description: "Open the Student Platform app.",
};

export default async function InstallStudentAppPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  const next = typeof params.next === "string" ? params.next : "";

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <section className="w-full max-w-md space-y-4 text-center">
        <InstallStudentAppBody token={token} next={next} />
      </section>
    </main>
  );
}
