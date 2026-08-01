export type MatchableMemory = {
  id: string;
  owner_id: string;
  category: string;
  content: string;
  pinned?: number;
  priority?: number;
  updated_at?: string;
};

export type DuplicateCandidate = {
  id: string;
  left: MatchableMemory;
  right: MatchableMemory;
  score: number;
};

const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
  "for", "from", "had", "has", "have", "he", "her", "hers", "him", "his",
  "i", "in", "is", "it", "its", "of", "on", "or", "our", "she", "that",
  "the", "their", "them", "they", "this", "to", "was", "we", "were", "with",
  "you", "your",
]);

const DEDUPE_GENERIC_WORDS = new Set([
  ...SEARCH_STOP_WORDS,
  "ai", "assistant", "becca", "chatgpt", "companion", "content", "memory",
  "memories", "model", "nox", "response", "responses", "rule", "rules", "says",
  "user", "wants",
]);

const NEGATIVE_WORDS = new Set([
  "avoid", "cannot", "cant", "disallow", "dislike", "dont", "forbid", "hate",
  "mustnt", "never", "no", "not", "without", "wont",
]);

function fold(value: string) {
  return value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stem(word: string) {
  if (word.length > 6 && word.endsWith("ingly")) return word.slice(0, -5);
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith("ied")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function semanticFold(value: string) {
  return fold(value)
    .replace(/\b(?:do\s+not|don't|never|must\s+not|mustn't)\s+use\b/g, " avoid ")
    .replace(/\b(?:does|do)\s+not\s+(?:like|want)\b/g, " avoid ")
    .replace(/\b(?:doesn't|don't)\s+(?:like|want)\b/g, " avoid ")
    .replace(/\b(?:dislikes?|hates?|forbids?|bans?|banned|forbidden)\b/g, " avoid ")
    .replace(/\b(?:is|are)\s+not\s+allowed\b/g, " avoid ")
    .replace(/\b(?:must\s+not|mustn't|cannot|can't|cant)\b/g, " cannot ")
    .replace(/\b(?:framing|formula|construction|pattern)\b/g, " pattern ");
}

function words(value: string, stopWords: Set<string>) {
  return semanticFold(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !stopWords.has(word))
    .map(stem)
    .filter((word) => word.length >= 2 && !stopWords.has(word));
}

function setEqual<T>(left: Set<T>, right: Set<T>) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function signature(value: string, pattern: RegExp) {
  return new Set([...fold(value).matchAll(pattern)].map((match) => match[0]));
}

function polarity(value: string) {
  const tokens = new Set(words(value, DEDUPE_GENERIC_WORDS));
  return [...NEGATIVE_WORDS].some((word) => tokens.has(word)) ? "negative" : "positive";
}

function tokenSimilarity(left: string, right: string) {
  const a = new Set(words(left, DEDUPE_GENERIC_WORDS));
  const b = new Set(words(right, DEDUPE_GENERIC_WORDS));
  if (!a.size || !b.size) return { intersection: 0, jaccard: 0, containment: 0 };
  const intersection = [...a].filter((word) => b.has(word)).length;
  const union = new Set([...a, ...b]).size;
  return {
    intersection,
    jaccard: intersection / union,
    containment: intersection / Math.min(a.size, b.size),
  };
}

export function canonicalExactMemory(value: string) {
  return fold(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSafeDuplicateCandidate(
  left: MatchableMemory,
  right: MatchableMemory,
) {
  if (left.id === right.id) return false;
  if (left.owner_id !== right.owner_id || left.category !== right.category) return false;
  if (canonicalExactMemory(left.content) === canonicalExactMemory(right.content)) return true;

  const leftNumbers = signature(left.content, /\b\d+(?:\.\d+)?\b/g);
  const rightNumbers = signature(right.content, /\b\d+(?:\.\d+)?\b/g);
  if (!setEqual(leftNumbers, rightNumbers)) return false;
  if (polarity(left.content) !== polarity(right.content)) return false;

  const leftQuoted = signature(left.content, /(["']).+?\1/g);
  const rightQuoted = signature(right.content, /(["']).+?\1/g);
  if (leftQuoted.size && rightQuoted.size && !setEqual(leftQuoted, rightQuoted)) return false;

  const similarity = tokenSimilarity(left.content, right.content);
  if (similarity.intersection < 2) return false;
  return (
    similarity.jaccard >= 0.72 ||
    (similarity.containment >= 0.84 && similarity.jaccard >= 0.54)
  );
}

export function exactDuplicateGroups<T extends MatchableMemory>(rows: T[]) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const canonical = canonicalExactMemory(row.content);
    if (!canonical) continue;
    const key = `${row.owner_id}\u0000${row.category}\u0000${canonical}`;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return [...groups.values()].filter((group) => group.length >= 2);
}

export function semanticDuplicateCandidates<T extends MatchableMemory>(
  rows: T[],
  excludedIds: Set<string> = new Set(),
  limit = 180,
) {
  const candidates: DuplicateCandidate[] = [];
  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    const left = rows[leftIndex];
    if (excludedIds.has(left.id)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
      const right = rows[rightIndex];
      if (excludedIds.has(right.id) || !isSafeDuplicateCandidate(left, right)) continue;
      const similarity = tokenSimilarity(left.content, right.content);
      candidates.push({
        id: `pair-${left.id}-${right.id}`,
        left,
        right,
        score: Math.max(similarity.jaccard, similarity.containment * 0.92),
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const used = new Set<string>();
  const selected: DuplicateCandidate[] = [];
  for (const candidate of candidates) {
    if (used.has(candidate.left.id) || used.has(candidate.right.id)) continue;
    selected.push(candidate);
    used.add(candidate.left.id);
    used.add(candidate.right.id);
    if (selected.length >= limit) break;
  }
  return selected;
}

export function memoryBrowserMatch(memory: MatchableMemory, rawQuery: string) {
  const query = fold(rawQuery);
  if (!query) return { matches: true, literal: true, overlap: 0 };
  const haystack = fold(`${memory.category} ${memory.content}`);
  const literal = haystack.includes(query);
  const queryWords = new Set(words(query, SEARCH_STOP_WORDS));
  const memoryWords = new Set(words(haystack, SEARCH_STOP_WORDS));
  const overlap = [...queryWords].filter((word) => memoryWords.has(word)).length;
  return {
    matches: literal || (queryWords.size > 0 && overlap === queryWords.size),
    literal,
    overlap,
  };
}

export function filterAndRankMemoryBrowser<T extends MatchableMemory>(
  rows: T[],
  rawQuery: string,
) {
  return rows
    .map((memory, index) => ({ memory, index, result: memoryBrowserMatch(memory, rawQuery) }))
    .filter((item) => item.result.matches)
    .sort(
      (a, b) =>
        Number(b.result.literal) - Number(a.result.literal) ||
        b.result.overlap - a.result.overlap ||
        Number(b.memory.pinned || 0) - Number(a.memory.pinned || 0) ||
        Number(b.memory.priority || 0) - Number(a.memory.priority || 0) ||
        a.index - b.index,
    )
    .map((item) => item.memory);
}

export type IncomingMemory = {
  content: string;
  category: string;
  scope: "shared" | "private";
  priority: number;
  pinned: boolean;
};

export type ExistingMemoryShape = {
  id: string;
  owner_id: string;
  category: string;
  content: string;
};

// Write-time duplicate policy: an exact canonical match anywhere on the
// companion's visible shelves (own + shared) blocks the write, and a
// near-duplicate blocks only under the guarded same-owner/same-category
// predicate that the supervised dedupe review already trusts.
export function dedupeIncomingMemories(
  existing: ExistingMemoryShape[],
  incoming: IncomingMemory[],
  companionId: string,
) {
  const seen = new Set(
    existing.map((row) => canonicalExactMemory(row.content)).filter(Boolean),
  );
  const kept: ExistingMemoryShape[] = [...existing];
  const toInsert: IncomingMemory[] = [];
  let skipped = 0;
  for (const row of incoming) {
    const fingerprint = canonicalExactMemory(row.content);
    if (!fingerprint || seen.has(fingerprint)) {
      skipped += 1;
      continue;
    }
    const ownerId = row.scope === "shared" ? "shared" : companionId;
    const candidate = {
      id: "incoming",
      owner_id: ownerId,
      category: row.category,
      content: row.content,
    };
    if (kept.some((other) => isSafeDuplicateCandidate(candidate, other))) {
      skipped += 1;
      continue;
    }
    seen.add(fingerprint);
    kept.push({ ...candidate, id: `incoming-${toInsert.length}` });
    toInsert.push(row);
  }
  return { toInsert, skipped };
}


const PROMPT_STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "are", "because", "been", "before",
  "being", "but", "can", "could", "did", "does", "for", "from", "had", "has",
  "have", "her", "here", "him", "his", "how", "into", "its", "just", "like",
  "more", "most", "not", "now", "our", "out", "she", "should", "some", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this",
  "those", "through", "too", "very", "was", "what", "when", "where", "which",
  "who", "why", "will", "with", "would", "you", "your",
]);

const PROMPT_CONCEPTS: Record<string, string[]> = {
  child: ["child", "children", "kid", "kids", "kiddo", "kiddos", "son", "sons", "daughter", "daughters"],
  name: ["name", "names", "named", "called"],
  birthday: ["birthday", "birthdate", "born"],
  partner: ["partner", "spouse", "husband", "wife", "married", "marriage"],
  preference: ["prefer", "prefers", "preference", "favorite", "favourite", "like", "likes", "love", "loves"],
  rule: ["rule", "rules", "boundary", "boundaries", "instruction", "instructions"],
  work: ["work", "works", "job", "career", "profession"],
  home: ["home", "house", "live", "lives", "location"],
};

type PromptMemoryShape = {
  content: string;
  category: string;
  pinned: number | boolean;
  priority: number;
};

function promptWords(value: string) {
  const raw = value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !PROMPT_STOP_WORDS.has(word));
  const concepts = new Map<string, string>();
  for (const [concept, variants] of Object.entries(PROMPT_CONCEPTS)) {
    for (const variant of variants) concepts.set(variant, concept);
  }
  return new Set(
    raw.map((word) => {
      const concept = concepts.get(word);
      if (concept) return concept;
      if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
      if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
      if (word.length > 4 && word.endsWith("s")) return word.slice(0, -1);
      return word;
    }),
  );
}

function relevanceScore(memory: PromptMemoryShape, queryWords: Set<string>) {
  const words = promptWords(`${memory.category} ${memory.content}`);
  let overlap = 0;
  for (const word of queryWords) if (words.has(word)) overlap += 1;
  return overlap * 1_000 + Math.max(0, Number(memory.priority) || 0) * 100;
}

// Prompt selection with a split budget: pinned rules keep a bounded number
// of guaranteed slots, and the rest of the budget goes to relevance against
// the conversation, so pinned continuity can never crowd out the memory the
// current conversation actually needs.
export function selectMemoryPromptRows<T extends PromptMemoryShape>(
  rows: T[],
  query: string,
  limit = 40,
  pinnedBudget = 15,
) {
  const applyCharacterBudget = (selected: T[]) => {
    const result: T[] = [];
    let characters = 0;
    for (const memory of selected) {
      const size = memory.content.length + memory.category.length + 8;
      if (characters + size > 18_000 && result.length >= 8) continue;
      result.push(memory);
      characters += size;
    }
    return result;
  };

  if (rows.length <= limit) return applyCharacterBudget(rows);

  const queryWords = promptWords(query);
  const indexed = rows.map((memory, index) => ({
    memory,
    index,
    pinned: Boolean(memory.pinned),
    score: relevanceScore(memory, queryWords),
  }));
  const pinnedRows = indexed
    .filter((item) => item.pinned)
    .sort(
      (a, b) =>
        (Number(b.memory.priority) || 0) - (Number(a.memory.priority) || 0) ||
        b.score - a.score ||
        a.index - b.index,
    )
    .slice(0, pinnedBudget);
  const chosenIds = new Set(pinnedRows.map((item) => item.index));
  const relevantRows = indexed
    .filter((item) => !chosenIds.has(item.index))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit - pinnedRows.length));

  const selected = [...pinnedRows, ...relevantRows]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.memory);
  return applyCharacterBudget(selected);
}
