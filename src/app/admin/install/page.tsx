import InstallPwaButton from "@/components/pwa/InstallPwaButton";

export const metadata = {
  title: "Install Admin App",
  description: "Install the Student Platform Admin app on your phone.",
};

export default function InstallAdminAppPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <section className="w-full max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-semibold">Install Admin App</h1>
        <p className="text-sm opacity-80">
          Tap the button below to install the Admin Platform as an app on your phone.
        </p>
        <InstallPwaButton appName="Admin App" autoPrompt />
      </section>
    </main>
  );
}
