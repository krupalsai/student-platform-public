/**
 * The Support menu — the tappable topics shown when a student opens Support
 * (the "811 Cares" pattern). Shared by the page (renders the buttons) and the
 * server (answers them). Every topic is answered from the student's OWN data
 * with no AI call and no admin involvement, so menu taps are free and never
 * count against the typed-message limit.
 *
 * Keep the labels stable: the server matches the exact label text.
 */
export const SUPPORT_MENU_TOPICS = [
  "Payment status",
  "Fee & how to pay",
  "My batch & seats",
  "Court case status",
  "Certificate steps",
  "Correct my details",
  "College ID / documents",
  "Registration status",
  "Stuck? Fix it in 2 minutes",
] as const;

export type SupportMenuTopic = (typeof SUPPORT_MENU_TOPICS)[number];

const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const BY_LABEL = new Map<string, SupportMenuTopic>(SUPPORT_MENU_TOPICS.map((t) => [normalise(t), t]));

export function asMenuTopic(text: string): SupportMenuTopic | null {
  return BY_LABEL.get(normalise(text)) ?? null;
}
