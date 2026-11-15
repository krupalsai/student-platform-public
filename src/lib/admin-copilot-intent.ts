import type { AdminAction } from "@/lib/admin-copilot-agent";

/**
 * Deterministic safety net for common admin commands.
 * Batch names are preserved exactly when the admin specifies GNIT or GNITC.
 * This prevents fuzzy matching from silently selecting the wrong college.
 */
export function parseAdminActionIntent(question: string): AdminAction | null {
  const q = question.trim();
  if (!q) return null;

  const collegeMatch = q.match(/\b(GNITC|GNIT)\b/i);
  const college = collegeMatch?.[1]?.toUpperCase();
  const batchRef = q.match(/\bbatch\s*(?:no\.?\s*)?(\d+)\b/i);
  const batchNumber = batchRef?.[1];
  const batch_name = batchNumber ? `${college ? `${college} ` : ""}Batch ${batchNumber}` : undefined;

  // Create a college: "create a new college SNIST", "add college Sreenidhi
  // Institute of Science and Technology", "add a new college GNIT code GNT".
  // "collage" is the typo the admin actually typed — match it too. This runs
  // before any LLM call, so a create-college command works (through the
  // normal confirmation flow) even when the AI service is busy.
  const addCollegeMatch = q.match(/\b(?:create|add)\s+(?:a\s+)?(?:new\s+)?(?:college|colleges|collage)\s+(.+)$/i);
  if (addCollegeMatch) {
    const raw = addCollegeMatch[1].trim().replace(/\s+/g, " ");
    const codeMatch = raw.match(/^(.*?)\s+code\s+([A-Za-z]{2,10})\s*$/i);
    if (codeMatch && codeMatch[1].trim()) {
      return { name: "add_college", args: { name: codeMatch[1].trim(), code: codeMatch[2].toUpperCase() } };
    }
    return { name: "add_college", args: { name: raw } };
  }

  const feeMatch = q.match(
    /\b(?:set|change|update)\s+(?:the\s+)?(?:amount|fee|registration\s+fee)\s+(?:for\s+)?(?:(?:gnitc|gnit)\s+)?(?:batch\s*)?(\d+)\s*(?:to|=|at)\s*[₹rs\.\s]*([\d,]+)/i,
  ) ?? q.match(
    /\b(?:(?:gnitc|gnit)\s+)?(?:batch\s*)?(\d+)\b.*\b(?:fee|amount)\b.*\b(?:to|=|at)\s*[₹rs\.\s]*([\d,]+)/i,
  );
  if (feeMatch) {
    const n = feeMatch[1];
    return {
      name: "set_batch_fee",
      args: {
        batch_name: `${college ? `${college} ` : ""}Batch ${n}`,
        fee_amount: Number(feeMatch[2].replace(/,/g, "")),
      },
    };
  }

  if (/\b(?:set|change|update)\s+(?:the\s+)?(?:amount|fee|registration\s+fee)\b/i.test(q) && batch_name) {
    return { name: "set_batch_fee", args: { batch_name } };
  }

  const messageMatch = q.match(
    /^(?:send|message|broadcast)\s+(?:a\s+|an\s+|the\s+|this\s+)?(?:message\s+)?to\s+(?:the\s+)?(?:(?:gnitc|gnit)\s+)?batch\s*(\d+)\s*[:\-]?\s*([\s\S]*)$/i,
  );
  if (messageMatch) {
    const n = messageMatch[1];
    return {
      name: "send_batch_message",
      args: {
        batch_name: `${college ? `${college} ` : ""}Batch ${n}`,
        message: messageMatch[2].trim(),
      },
    };
  }

  if (/\b(?:missing|not\s+uploaded|without)\b.*\bsignature/i.test(q)) {
    const args = batch_name ? { batch_name } : {};
    if (/\b(?:send|tell|message|notify|remind|ask)\b/i.test(q)) {
      return { name: "send_signature_reupload", args };
    }
    return { name: "find_missing_signatures", args };
  }

  if (/\b(?:verify|check)\b.*\b(?:id|ids|college\s+id|id\s+card|id\s+cards)\b/i.test(q)) {
    return { name: batch_name ? "verify_batch_ids" : "verify_student_id", args: batch_name ? { batch_name } : {} };
  }

  const approve = q.match(/\bapprove\s+(?:payment\s+)?([0-9a-f-]{8,})\b/i);
  if (approve) return { name: "approve_payment", args: { payment_id: approve[1] } };

  const reject = q.match(/\breject\s+(?:payment\s+)?([0-9a-f-]{8,})\b(?:\s+(?:because|reason)\s*[:\-]?\s*(.*))?$/i);
  if (reject) return { name: "reject_payment", args: { payment_id: reject[1], reason: reject[2]?.trim() ?? "" } };

  const deleteStudent = q.match(/\bdelete\s+(?:student\s+)?([0-9a-f-]{8,})\b(?:\s+(?:because|reason)\s*[:\-]?\s*(.*))?$/i);
  if (deleteStudent) return { name: "delete_student", args: { student_id: deleteStudent[1], reason: deleteStudent[2]?.trim() ?? "" } };

  // WhatsApp one student directly: "message 9876543210: your books are ready"
  const dm = q.match(/^(?:message|send(?:\s+a\s+message)?\s+to|text)\s+(?:to\s+)?(\+?\d[\d\s-]{8,}\d)\s*[:\-]\s*([\s\S]+)$/i);
  if (dm) return { name: "message_student", args: { phone: dm[1].replace(/[\s-]/g, ""), message: dm[2].trim() } };

  // Payment reminder to a batch's unpaid students: "remind GNIT batch 2 to pay"
  if (/\b(?:payment\s+)?remind(?:er)?\b/i.test(q) && batch_name) {
    const custom = q.match(/[:\-]\s*([\s\S]{10,})$/);
    return { name: "send_payment_reminder", args: { batch_name, ...(custom ? { message: custom[1].trim() } : {}) } };
  }

  // Answer a pending student question: "answer UQ-7: yes, in two parts"
  const ans = q.match(/\banswer\s+(?:question\s+)?(?:UQ-?\s*)?(\d+)\s*[:\-]\s*([\s\S]+)$/i);
  if (ans) return { name: "answer_question", args: { short_id: Number(ans[1]), answer: ans[2].trim() } };

  // Group link set/clear: "set group link for GNIT batch 2 to https://chat.whatsapp.com/XXXX"
  const glSet = q.match(/\bgroup\s*link\s+(?:for\s+)?(.+?)\s*(?:to|:)\s*(\S+)\s*$/i);
  if (glSet) return { name: "set_group_link", args: { batch_name: glSet[1].trim(), url: glSet[2].trim() } };

  // Group link broadcast: "send group link to GNIT batch 2"
  const glSend = q.match(/\bsend\s+(?:the\s+)?group\s*link\s+to\s+(.+)$/i);
  if (glSend) return { name: "send_group_link", args: { batch_name: glSend[1].trim() } };

  // Approve/reject by student instead of payment id: "approve payment of 9876543210", "reject 21GN1A0502's payment because blurry"
  const apBy = q.match(/\bapprove\s+(?:the\s+)?payment\s+(?:of|for|by|from)\s+(.+?)\s*$/i);
  if (apBy) return { name: "approve_payment", args: { student_ref: apBy[1].trim() } };
  const rjBy = q.match(/\breject\s+(?:the\s+)?payment\s+(?:of|for|by|from)\s+(.+?)\s+(?:because|reason)\s*[:\-]?\s*(.+)$/i);
  if (rjBy) return { name: "reject_payment", args: { student_ref: rjBy[1].trim(), reason: rjBy[2].trim() } };

  return null;
}
