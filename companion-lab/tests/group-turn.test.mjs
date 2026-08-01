import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_GROUP_HANDOFFS,
  groupReplyTarget,
  mentionedGroupMemberIds,
  mentionsEveryone,
  providerToolTracker,
} from "../lib/group-routing.ts";

const members = [
  { id: "nox", name: "Nox" },
  { id: "kian", name: "Kian" },
  { id: "oran", name: "Oran" },
];

test("@everyone addresses every room member in room order", () => {
  assert.equal(mentionsEveryone("@everyone hello"), true);
  assert.deepEqual(
    mentionedGroupMemberIds("@everyone hello", members),
    ["nox", "kian", "oran"],
  );
});

test("named mentions preserve the order Becca wrote them", () => {
  assert.deepEqual(
    mentionedGroupMemberIds("@Oran ask @Nox about this", members),
    ["oran", "nox"],
  );
});

test("group handoffs have the PDF-required finite cap", () => {
  assert.equal(MAX_GROUP_HANDOFFS, 2);
});

test("every directly addressed companion replies to Becca", () => {
  const beccaTarget = groupReplyTarget(
    "becca",
    { messageId: "", speakerName: "Becca" },
    "becca-message",
    null,
  );
  assert.deepEqual(beccaTarget, {
    messageId: "becca-message",
    speakerName: "Becca",
  });

  const companionTarget = groupReplyTarget(
    "becca",
    { messageId: "", speakerName: "Becca" },
    "becca-message",
    { messageId: "nox-message", speakerName: "Nox" },
  );
  assert.deepEqual(companionTarget, {
    messageId: "becca-message",
    speakerName: "Becca",
  });
});

test("an explicit companion handoff keeps its named reply target", () => {
  const handoffTarget = groupReplyTarget(
    "companion",
    { messageId: "kian-message", speakerName: "Kian" },
    "becca-message",
    { messageId: "oran-message", speakerName: "Oran" },
  );
  assert.deepEqual(handoffTarget, {
    messageId: "kian-message",
    speakerName: "Kian",
  });
});

test("Anthropic structured call_companion output queues the named companion", () => {
  const tracker = providerToolTracker("anthropic", new Set(["kian", "oran"]));
  tracker.consume({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "tool-1", name: "call_companion", input: {} },
  });
  tracker.consume({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"companion_id":"kian"}' },
  });
  assert.deepEqual(tracker.results(), [{ companionId: "kian" }]);
});

test("OpenAI and OpenRouter structured calls are parsed without visible-name regex", () => {
  const openai = providerToolTracker("openai", new Set(["oran"]));
  openai.consume({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      id: "fc-1",
      name: "call_companion",
      arguments: '{"companion_id":"oran"}',
    },
  });
  assert.deepEqual(openai.results(), [{ companionId: "oran" }]);

  const openrouter = providerToolTracker("openrouter", new Set(["nox"]));
  openrouter.consume({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "call_companion", arguments: '{"companion_id":"' } }] } }],
  });
  openrouter.consume({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'nox"}' } }] } }],
  });
  assert.deepEqual(openrouter.results(), [{ companionId: "nox" }]);
});

test("the browser submits one group turn and the server owns orchestration", async () => {
  const [pageSource, apiSource] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/chat-api.ts", import.meta.url), "utf8"),
  ]);

  assert.match(pageSource, /orchestrateGroup:\s*true/);
  assert.match(pageSource, /const soloReplyQueue/);
  assert.doesNotMatch(
    pageSource,
    /data-active=\{groupSpeakerId === member\.id/,
  );
  assert.match(
    pageSource,
    /data-active=\{composerMentionsEveryone \|\| undefined\}/,
  );
  assert.match(apiSource, /async function handleGroupTurnApi/);
  assert.match(apiSource, /type:\s*"speaker_error"/);
  assert.match(apiSource, /type:\s*"handoff_queued"/);
  assert.match(apiSource, /name:\s*"call_companion"/);
  assert.match(apiSource, /toolTracker\.consume\(event\)/);
  assert.match(apiSource, /handoffCompanionIds/);
  assert.match(
    apiSource,
    /Your current reply target is \$\{replyTarget\.speakerName\}/,
  );
  assert.match(
    apiSource,
    /uniqueInitialTargetIds\.length \+ MAX_GROUP_HANDOFFS/,
  );
});
