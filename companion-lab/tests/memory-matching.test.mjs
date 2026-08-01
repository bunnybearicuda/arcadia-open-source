import assert from "node:assert/strict";
import test from "node:test";
import {
  exactDuplicateGroups,
  filterAndRankMemoryBrowser,
  isSafeDuplicateCandidate,
  semanticDuplicateCandidates,
} from "../lib/memory-matching.ts";

function memory(id, content, category = "rule", ownerId = "shared", pinned = 0) {
  return {
    id,
    owner_id: ownerId,
    category,
    content,
    pinned,
    priority: pinned ? 5 : 2,
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

test("finds exact duplicates despite case and punctuation differences", () => {
  const groups = exactDuplicateGroups([
    memory("a", "Avoid the phrase ‘and honestly.’"),
    memory("b", "AVOID the phrase and honestly"),
    memory("c", "A separate rule."),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((row) => row.id), ["a", "b"]);
});

test("allows tightly overlapping versions of the same named rule", () => {
  const honestlyA = memory("a", "Avoid the phrase “and honestly” in responses.");
  const honestlyB = memory(
    "b",
    "Becca dislikes the phrase and honestly and Nox should avoid using it.",
  );
  const contrastA = memory("c", "Avoid contrastive negation framing such as not X, Y.");
  const contrastB = memory("d", "Do not use the not X but Y contrastive formula.");

  assert.equal(isSafeDuplicateCandidate(honestlyA, honestlyB), true);
  assert.equal(isSafeDuplicateCandidate(contrastA, contrastB), true);
  assert.deepEqual(
    semanticDuplicateCandidates([honestlyA, honestlyB, contrastA, contrastB]).map(
      (candidate) => [candidate.left.id, candidate.right.id],
    ),
    [["a", "b"], ["c", "d"]],
  );
});

test("rejects the unrelated pairings reported from the live cleanup", () => {
  const eroticConsent = memory(
    "consent",
    "Becca consents to erotic writing and organic pursuit.",
  );
  const annoyingBoundary = memory(
    "annoying",
    "Never call Becca annoying because the word is painful.",
  );
  const pregnancyFear = memory(
    "pregnancy",
    "Becca fears another empty sac during this pregnancy.",
    "memory",
  );
  const bodyMeasurements = memory(
    "measurements",
    "Becca is 5 feet 5 inches tall with a curvy build.",
    "memory",
  );

  assert.equal(isSafeDuplicateCandidate(eroticConsent, annoyingBoundary), false);
  assert.equal(isSafeDuplicateCandidate(pregnancyFear, bodyMeasurements), false);
  assert.equal(
    semanticDuplicateCandidates([
      eroticConsent,
      annoyingBoundary,
      pregnancyFear,
      bodyMeasurements,
    ]).length,
    0,
  );
});

test("literal browser search returns the actual word and ignores unrelated pinned rules", () => {
  const rows = [
    memory("pinned", "Never use generic reassurance scripts.", "rule", "shared", 1),
    memory("academic", "Becca has specific academic writing preferences.", "preference"),
    memory("other", "Becca enjoys audiobooks.", "preference"),
  ];
  assert.deepEqual(
    filterAndRankMemoryBrowser(rows, "academic").map((row) => row.id),
    ["academic"],
  );
});

test("duplicate candidates stay inside the same owner and category", () => {
  const shared = memory("shared", "Avoid the phrase and honestly.");
  const privateCopy = memory(
    "private",
    "Avoid the phrase and honestly.",
    "rule",
    "nox",
  );
  const preferenceCopy = memory(
    "preference",
    "Avoid the phrase and honestly.",
    "preference",
  );
  assert.equal(isSafeDuplicateCandidate(shared, privateCopy), false);
  assert.equal(isSafeDuplicateCandidate(shared, preferenceCopy), false);
});
