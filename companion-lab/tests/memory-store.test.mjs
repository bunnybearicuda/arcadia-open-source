import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupeIncomingMemories,
  selectMemoryPromptRows,
} from "../lib/memory-matching.ts";

function existing(id, content, ownerId = "kian", category = "memory") {
  return { id, owner_id: ownerId, category, content };
}

function incoming(content, overrides = {}) {
  return {
    content,
    category: "memory",
    scope: "private",
    priority: 2,
    pinned: false,
    ...overrides,
  };
}

test("blocks an exact duplicate that differs only in case and punctuation", () => {
  const { toInsert, skipped } = dedupeIncomingMemories(
    [existing("a", "Becca prefers tea over coffee.")],
    [incoming("becca prefers TEA over coffee")],
    "kian",
  );
  assert.equal(toInsert.length, 0);
  assert.equal(skipped, 1);
});

test("blocks a near-duplicate wording variant on the same shelf and category", () => {
  const { toInsert, skipped } = dedupeIncomingMemories(
    [existing("a", "Becca prefers tea over coffee in the morning.")],
    [incoming("Becca prefers tea over coffee every morning.")],
    "kian",
  );
  assert.equal(toInsert.length, 0);
  assert.equal(skipped, 1);
});

test("a conservative miss is allowed: reworded rules that share few tokens both survive", () => {
  const { toInsert } = dedupeIncomingMemories(
    [existing("a", "Avoid using the phrase 'and honestly' in replies.", "kian", "rule")],
    [incoming("Do not open messages with rhetorical questions.", { category: "rule" })],
    "kian",
  );
  assert.equal(toInsert.length, 1);
});

test("keeps memories whose numbers differ even when wording is close", () => {
  const { toInsert } = dedupeIncomingMemories(
    [existing("a", "Becca's appointment is on June 3.")],
    [incoming("Becca's appointment is on June 4.")],
    "kian",
  );
  assert.equal(toInsert.length, 1);
});

test("keeps genuinely new memories and deduplicates within one batch", () => {
  const { toInsert, skipped } = dedupeIncomingMemories(
    [existing("a", "Becca has two cats.")],
    [
      incoming("Becca's favorite season is autumn."),
      incoming("Becca's favorite season is autumn."),
      incoming("Kian and Becca met in a writing thread.", { scope: "shared" }),
    ],
    "kian",
  );
  assert.equal(toInsert.length, 2);
  assert.equal(skipped, 1);
});

test("exact duplicate on the shared shelf blocks a private write of the same fact", () => {
  const { toInsert, skipped } = dedupeIncomingMemories(
    [existing("a", "Becca's birthday is in March.", "shared")],
    [incoming("Becca's birthday is in March!")],
    "kian",
  );
  assert.equal(toInsert.length, 0);
  assert.equal(skipped, 1);
});

function promptMemory(id, content, { pinned = 0, priority = 2, category = "memory" } = {}) {
  return { id, content, category, pinned, priority };
}

test("pinned rows cannot crowd relevant rows out of the prompt budget", () => {
  const rows = [];
  for (let index = 0; index < 60; index += 1) {
    rows.push(
      promptMemory(`pin-${index}`, `Standing rule number ${index} about reply style.`, {
        pinned: 1,
        priority: 5,
        category: "rule",
      }),
    );
  }
  for (let index = 0; index < 30; index += 1) {
    rows.push(promptMemory(`note-${index}`, `Note ${index} about a talk Becca attended.`));
  }
  rows.push(
    promptMemory("target", "Becca is preparing an academic conference talk in Boston."),
  );
  const selected = selectMemoryPromptRows(rows, "how is the academic talk going", 40);
  const ids = selected.map((row) => row.id);
  assert.ok(ids.includes("target"), "the relevant memory must survive pinned pressure");
  assert.ok(
    ids.filter((id) => id.startsWith("pin-")).length <= 15,
    "pinned rows stay within their budget when relevant rows compete",
  );
});

test("relevance orders the unpinned portion of the selection", () => {
  const rows = [
    ...Array.from({ length: 50 }, (_, index) =>
      promptMemory(`filler-${index}`, `Unrelated note ${index} about the weather log.`),
    ),
    promptMemory("cats", "Becca has two cats named Juniper and Moss."),
  ];
  const selected = selectMemoryPromptRows(rows, "tell me about becca's cats", 20);
  assert.ok(selected.some((row) => row.id === "cats"));
});

test("a small memory base is passed through untouched", () => {
  const rows = [
    promptMemory("a", "Becca prefers morning check-ins."),
    promptMemory("b", "Kian uses a workshop metaphor.", { pinned: 1, priority: 5 }),
  ];
  const selected = selectMemoryPromptRows(rows, "anything", 40);
  assert.equal(selected.length, 2);
});
