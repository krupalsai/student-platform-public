import { createServiceClient } from "@/lib/supabase/server";
import {
  getLawyerBatchIds,
  getLawyerBatch,
  validateLawyerToken,
} from "@/lib/lawyer";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Lawyer — Batch photos",
  robots: { index: false, follow: false },
};

export default async function LawyerPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const { t } = await searchParams;
  const token = t ?? "";
  const ok = await validateLawyerToken(token);

  if (!ok) {
    return (
      <main className="min-h-screen bg-gray-50 px-4 py-16">
        <div className="mx-auto max-w-md rounded-2xl bg-white p-6 text-center shadow">
          <h1 className="text-lg font-bold text-gray-900">Link not valid</h1>
          <p className="mt-2 text-sm text-gray-600">
            This download link is not valid. Please ask the platform administrator for a fresh link.
          </p>
        </div>
      </main>
    );
  }

  const db = createServiceClient();
  const batchIds = await getLawyerBatchIds(db);
  const batches = (
    await Promise.all(batchIds.map((id) => getLawyerBatch(db, id)))
  ).filter((b): b is NonNullable<typeof b> => b !== null);

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-xl font-bold text-gray-900">
          Batch photos — for the lawyer
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          Each ZIP has every petitioner&apos;s photo file (named with the
          student&apos;s name) plus the batch&apos;s names list. Photos are the
          students&apos; college ID card images — the card carries each
          student&apos;s photo.
        </p>

        <div className="mt-6 space-y-4">
          {batches.map((b) => (
            <section
              key={b.id}
              className="rounded-2xl bg-white p-5 shadow"
            >
              <h2 className="text-lg font-bold text-gray-900">{b.name}</h2>
              <p className="mt-1 text-sm text-gray-600">{b.caseLine}</p>
              <p className="mt-2 text-sm text-gray-800">
                Petitioners: <strong>{b.petitioners.length}</strong>
                {" · "}
                Photos in the ZIP:{" "}
                <strong>
                  {b.photoCount} of {b.petitioners.length}
                </strong>
              </p>
              {b.missingPhotoNames.length > 0 && (
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  Photo missing for: {b.missingPhotoNames.join(", ")}
                </p>
              )}
              <a
                href={`/api/lawyer/batch-zip?batch=${b.id}&t=${encodeURIComponent(token)}`}
                className="mt-4 inline-block rounded-full bg-green-600 px-5 py-2.5 text-sm font-semibold text-white"
              >
                Download batch ZIP ({b.photoCount} photos + names list)
              </a>
            </section>
          ))}
          {batches.length === 0 && (
            <p className="rounded-2xl bg-white p-5 text-sm text-gray-600 shadow">
              No batches found. Please ask Krupal to check.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
