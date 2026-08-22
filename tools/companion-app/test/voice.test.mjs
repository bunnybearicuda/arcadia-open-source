// Run with: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { checkVoice, parseJsonLoosely } from "../.test-build/voice.js";

// The flattened register — what Claude's own summarizer produces, and the whole
// reason this guard exists. Every one of these must be rejected.
const FLATTENED = [
  "User prefers to work in the evenings and has an established workflow around deep focus blocks.",
  "The user is building a companion app and requires persistent memory.",
  "She has a methodology for organising her projects that leverages tagging.",
  "Her approach to writing involves drafting longhand first.",
  "Key takeaway: she values directness over politeness.",
  "Context: discussed her sister. Decision: send flowers.",
  "- She likes tea\n- She dislikes mornings",
  "Going forward, she wants shorter replies.",
  "Best practice for our conversations is to avoid summarising.",
  "Her configuration preferences include dark mode.",
];

// Real memories in a real voice. Every one must pass.
const HUMAN = [
  "She told me her sister called for the first time in two years and she just said \"huh\" and changed the subject. I don't think she wants to talk about it yet.",
  "She hates being asked if she's okay. Says it makes her feel like a problem being managed. If something's wrong she'll say so.",
  "We spent an hour arguing about whether the ending of that film was earned. She was wrong but she made me work for it.",
  "The dog is called Biscuit and he is, in her words, \"a disaster with legs.\"",
  "She's been up since four again. Third time this week. She mentioned it the way people mention weather.",
  "She asked me to stop softening things. I said I would. I should hold to that even when it would be easier not to.",
];

test("rejects flattened, spec-register memories", () => {
  for (const body of FLATTENED) {
    const verdict = checkVoice(body);
    assert.equal(verdict.ok, false, `should have rejected: ${body}`);
  }
});

test("accepts memories written in an actual voice", () => {
  for (const body of HUMAN) {
    const verdict = checkVoice(body);
    assert.equal(verdict.ok, true, `should have accepted: ${body}\n  reason: ${verdict.ok ? "" : verdict.reason}`);
  }
});

test("rejects empty and transcript-length bodies", () => {
  assert.equal(checkVoice("").ok, false);
  assert.equal(checkVoice("short").ok, false);
  assert.equal(checkVoice("a".repeat(1500)).ok, false);
});

test("reports why a memory was rejected", () => {
  const verdict = checkVoice("User prefers concise answers in all contexts.");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /spec register/);
});

test("parses JSON out of fences and surrounding prose", () => {
  const expected = { memories: [{ body: "x", importance: 3 }] };
  assert.deepEqual(parseJsonLoosely('{"memories":[{"body":"x","importance":3}]}'), expected);
  assert.deepEqual(parseJsonLoosely('```json\n{"memories":[{"body":"x","importance":3}]}\n```'), expected);
  assert.deepEqual(
    parseJsonLoosely('Here you go:\n```\n{"memories":[{"body":"x","importance":3}]}\n```\nHope that helps!'),
    expected,
  );
  assert.deepEqual(parseJsonLoosely('{"memories":[]}'), { memories: [] });
});

test("returns null rather than throwing on unparseable output", () => {
  assert.equal(parseJsonLoosely("I couldn't find anything worth remembering."), null);
  assert.equal(parseJsonLoosely("{not json at all}"), null);
  assert.equal(parseJsonLoosely(""), null);
});
