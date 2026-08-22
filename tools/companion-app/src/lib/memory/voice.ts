/**
 * The voice guard.
 *
 * The prompt tells the extractor how to write. This enforces it, because a
 * prompt is a request and this is a rule. A memory that reads like
 * documentation is worse than no memory at all — every time it gets loaded it
 * teaches the companion a register that isn't theirs, and after a few hundred
 * of them the person in the memories is a systematised stranger.
 *
 * Rejected memories are dropped, not rewritten. Losing one is cheap; keeping a
 * flattened one is not.
 */

/**
 * Phrasings that mean the model started writing a spec instead of remembering.
 * Matched case-insensitively against the whole memory body.
 */
export const BANNED_REGISTER =
  /\b(user (?:prefers|wants|likes|needs|is|has)|the user\b|workflow|leverage|utili[sz]e|streamline|methodolog|use case|best practice|key takeaway|going forward|it should be noted|approach to|configuration|requirements?\b)/i;

/** A bulleted list inside a memory means it started taking minutes. */
const BULLETED = /^\s*[-*•]\s/m;

/** "Context:", "Decision:" — the shape of a ticket, not a memory. */
const LABELLED = /^\s*(context|decision|summary|notes?|takeaway|action items?)\s*:/im;

export type VoiceVerdict = { ok: true } | { ok: false; reason: string };

export function checkVoice(body: string): VoiceVerdict {
  const text = body.trim();
  if (text.length < 12) return { ok: false, reason: "too short to be a memory" };
  if (text.length > 1200) return { ok: false, reason: "too long — that's a transcript" };

  const banned = text.match(BANNED_REGISTER);
  if (banned) return { ok: false, reason: `spec register: "${banned[0]}"` };
  if (BULLETED.test(text)) return { ok: false, reason: "bulleted list" };
  if (LABELLED.test(text)) return { ok: false, reason: "labelled like a ticket" };

  return { ok: true };
}

/**
 * Models sometimes wrap JSON in prose or a fence despite being told not to.
 * Pull the outermost object out rather than failing the whole extraction.
 */
export function parseJsonLoosely(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}
