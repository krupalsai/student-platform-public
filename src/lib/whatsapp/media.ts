/**
 * Downloads media (photos) a student sends to the WhatsApp bot.
 *
 * Meta's Cloud API is two-step: GET /{media-id} returns a short-lived URL +
 * mime_type, then that URL itself must be fetched with the SAME bearer
 * token (it's not public). Mirrors the auth pattern in client.ts.
 */

const ACCESS_TOKEN  = process.env.WHATSAPP_ACCESS_TOKEN ?? "";
const GRAPH_VERSION = "v20.0";

export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
}

export async function downloadWhatsAppMedia(mediaId: string): Promise<DownloadedMedia | null> {
  if (!ACCESS_TOKEN) {
    console.warn("[wa-media] WHATSAPP_ACCESS_TOKEN missing");
    return null;
  }
  try {
    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    if (!metaRes.ok) {
      console.error("[wa-media] media metadata fetch failed", metaRes.status);
      return null;
    }
    const meta = await metaRes.json();
    const url: string | undefined = meta?.url;
    const mimeType: string = meta?.mime_type ?? "image/jpeg";
    if (!url) return null;

    const fileRes = await fetch(url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
    if (!fileRes.ok) {
      console.error("[wa-media] media download failed", fileRes.status);
      return null;
    }
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    return { buffer, mimeType };
  } catch (e) {
    console.error("[wa-media] download threw", (e as Error).message);
    return null;
  }
}
