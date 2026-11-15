import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import {
  filterEngineeringColleges,
  getEngineeringDirectorySource,
  getOnlineEngineeringColleges,
  searchOnlineEngineeringColleges,
} from "@/lib/services/online-colleges";
import { issueCollegeSelectionToken } from "@/lib/whatsapp/college-selection";
import { getWhatsAppDisplayNumber } from "@/lib/whatsapp/client";
import { logSystemError } from "@/lib/system-errors";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const FEATURED_COLLEGES = [
  { id: "GNIT", name: "Guru Nanak Institute of Technology" },
  { id: "GNITC", name: "Guru Nanak Institutions Technical Campus" },
] as const;

function normaliseCollegeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isFeaturedAlias(id: string): boolean {
  return id === "GNIT" || id === "GNITC";
}

function buildInitialResults(
  colleges: Awaited<ReturnType<typeof getOnlineEngineeringColleges>>,
) {
  const featured = FEATURED_COLLEGES.map((wanted) => {
    const match = colleges.find(
      (college) =>
        normaliseCollegeName(college.name) === normaliseCollegeName(wanted.name),
    );
    if (!match) throw new Error(`Required featured college missing from live AICTE directory: ${wanted.name}`);
    return { id: wanted.id, name: match.name };
  });

  const featuredNames = new Set(featured.map((college) => normaliseCollegeName(college.name)));
  const rest = searchOnlineEngineeringColleges(colleges, "").filter(
    (college) => !featuredNames.has(normaliseCollegeName(college.name)),
  );

  return [...featured, ...rest].slice(0, 25);
}

export async function GET(req: NextRequest) {
  try {
    const q = (req.nextUrl.searchParams.get("q") ?? "").trim();

    // Always load and validate the complete live AICTE engineering directory.
    // Never derive the total from the two featured colleges.
    const allColleges = await getOnlineEngineeringColleges();
    const colleges = filterEngineeringColleges(allColleges);
    if (colleges.length < 100) {
      throw new Error(`Engineering directory unexpectedly contains ${colleges.length} records`);
    }

    const source = await getEngineeringDirectorySource();
    const matches = q
      ? searchOnlineEngineeringColleges(colleges, q)
      : buildInitialResults(colleges);

    return NextResponse.json({
      colleges: matches,
      total: colleges.length,
      source,
      year: "2026-2027",
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("[college-search] live AICTE directory failed validation", e);
    await logSystemError(createServiceClient(), "api/college-search", e);
    return NextResponse.json(
      { error: "The live AICTE engineering-college directory is temporarily unavailable or incomplete. Please retry." },
      { status: 503 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const phone = String(body.phone ?? "").trim();
    const requestedCollegeId = String(body.collegeId ?? "").trim();
    const requestedCollegeName = String(body.collegeName ?? "").trim();

    if (!phone || !requestedCollegeId || !requestedCollegeName) {
      return NextResponse.json({ error: "Invalid college selection" }, { status: 400 });
    }

    const colleges = filterEngineeringColleges(await getOnlineEngineeringColleges());
    let college = colleges.find(
      (c) =>
        c.id === requestedCollegeId &&
        normaliseCollegeName(c.name) === normaliseCollegeName(requestedCollegeName),
    );

    // Featured cards use stable UI aliases (GNIT/GNITC), while the live AICTE
    // directory uses its own institution IDs. Resolve only against the exact
    // live institution name before issuing the one-time WhatsApp token.
    if (!college && isFeaturedAlias(requestedCollegeId)) {
      const wanted = normaliseCollegeName(requestedCollegeName);
      college = colleges.find((c) => normaliseCollegeName(c.name) === wanted);
    }

    if (!college) {
      return NextResponse.json(
        { error: "That engineering college is not in the live AICTE directory." },
        { status: 400 },
      );
    }

    const db = createServiceClient();

    // Website selection is temporary. The permanent colleges row is created
    // only when the one-time selection is consumed in the WhatsApp flow.
    await issueCollegeSelectionToken(db, phone, college.id, college.name);

    const message = college.name;
    const botNumber = await getWhatsAppDisplayNumber();
    if (!botNumber) {
      return NextResponse.json({ error: "WhatsApp bot number is not configured." }, { status: 503 });
    }

    const whatsappUrl =
      "https://wa.me/" + botNumber + "?text=" + encodeURIComponent(message);

    return NextResponse.json({ ok: true, whatsappUrl, message });
  } catch (e) {
    console.error("[college-search] selection failed", e);
    await logSystemError(createServiceClient(), "api/college-search:select", e);
    return NextResponse.json({ error: "Unable to create college selection" }, { status: 500 });
  }
}
