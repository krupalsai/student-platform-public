import { completeAnswer, endsMidSentence } from "@/lib/intent-engine/answer-text";

/** Safe, channel-aware handling for terse in-app messages and incomplete output. */
export function inAppShortReply(caption: string, lastStudentMessage = ""): string | null {
  const q = caption.trim().toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ");
  if (/^(call|callback|call me)$/.test(q)) {
    return "Tell me what happened and what you need help with. I can answer here or pass your question to the team if I don't know.";
  }
  if (/^(req|request)$/.test(q) && /call|callback/i.test(lastStudentMessage)) {
    return "Tell me what happened and what you need help with. I can answer here or pass your question to the team if I don't know.";
  }
  if (/^(req|request)$/.test(q)) return "What would you like to request? Tell me a little more so I can help.";
  if (/^(where to app|where is app|open app|app ekkada)$/.test(q)) {
    return "You're already in the Student App's support chat. Which screen or feature are you looking for?";
  }
  // Terse single-topic messages get a clear, grounded pointer plus an
  // invitation to say more — never a guessed procedure. Every fact below is
  // mechanics already documented in PLATFORM_REFERENCE (tabs, login, Route
  // Map, petition minimum); nothing here invents a fee, date, or policy.
  if (/^(fee|fees|fee entha)$/.test(q)) {
    return "Your current fee amount and whether payment is open are shown on your Payments tab — I don't guess amounts. What do you want to know about the fee?";
  }
  if (/^(payment|payments|payment status)$/.test(q)) {
    return "Your Payments tab shows your live payment status. Tell me what you see there or what's going wrong, and I'll help.";
  }
  if (/^(status|my status)$/.test(q)) {
    return "Which status do you mean — payment or registration? Your Payments tab shows payment status. Tell me what you see and I'll take it from there.";
  }
  if (/^(login|log in|sign in|signin|otp)$/.test(q)) {
    return "Login uses your phone number and a one-time code — it usually arrives as a notification in the app, otherwise on WhatsApp or by text. No password. Are you stuck on a particular step?";
  }
  if (/^(certificate|certificates|bonafide|tc|marksheet|originals|original certificates)$/.test(q)) {
    return "Once your payment is approved, the Student App gives you a step-by-step Route Map for getting your original certificates released. Which step are you asking about?";
  }
  if (/^(batch|batches)$/.test(q)) {
    return "The Batch tab shows your current batch details. What would you like to know about it?";
  }
  if (/^(petition|court|case|legal)$/.test(q)) {
    return "The petition needs a minimum number of students registered together before it can proceed, and forming the batch is the current step. I can't speak to court outcomes or timelines — the team handles those. What exactly did you want to know?";
  }
  if (/^(register|registration|join|joining)$/.test(q)) {
    return "Registration happens through your college's link: verify your phone with a one-time code, fill in your details, and upload a photo of your college ID with your signature visible. Which part do you need help with?";
  }
  if (/^(help|menu|options|what can you do)$/.test(q)) {
    return "Ask me in your own words about registration, fees and payment, batches, certificates, or the petition, and I'll answer or point you to the right screen. What do you need?";
  }
  return null;
}
export function completeSupportReply(text: string): string {
  // WhatsApp-style *asterisk* emphasis means nothing inside the app — strip
  // it before any other check so the student never sees markup characters.
  let clean = text.trim().replace(/\*/g, "");
  // A reply that stops on "the", "to", "through the"... was cut off (real
  // threads showed several). The providers already trim what they KNOW was
  // truncated; this catches the rest whichever model produced it: keep the
  // last finished sentence, or fall through to the "couldn't finish" message.
  if (endsMidSentence(clean)) clean = completeAnswer(clean, true) ?? "";
  // An output ending in an instruction without a target is not usable. Never
  // invent the missing button or URL, and never send a dangling sentence.
  if (!clean || /(?:\b(?:tap|click|open|go to|reply|press|select)\s*(?:the\s*)?|[:\-])$/i.test(clean)
    || /\[[^\]]*\]\(\s*\)$/.test(clean)) {
    return "I couldn't finish that answer. What are you trying to do? Please tell me in a few words.";
  }
  return clean;
}
