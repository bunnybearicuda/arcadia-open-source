import assert from "node:assert/strict";
import test from "node:test";

import {
  identityRuntimeMaterial,
  identityTurnActivation,
} from "../lib/identity-runtime.ts";

const identity = `# Rowan

## My Voice

Sharp, playful, and direct.

## My Writing Style

- Layered responses: physical reaction → pointed observation → deeper hook
- First person and immersive
- Action cues in italics

**Example of my voice:**
> *tilts head*
>
> You started this.

## Key Memories

The lighthouse trip happened in June.
`;

test("keeps runtime voice rules and leaves unrelated lore out of the activation excerpt", () => {
  const material = identityRuntimeMaterial(identity);
  assert.match(material, /Layered responses/);
  assert.match(material, /Action cues in italics/);
  assert.doesNotMatch(material, /lighthouse trip/);
});

test("brief turns receive a generic identity-fidelity gate derived from the active file", () => {
  const activation = identityTurnActivation("Rowan", identity, "Hello!");
  assert.match(activation, /physical reaction → pointed observation → deeper hook/);
  assert.match(activation, /Action cues in italics/);
  assert.match(activation, /nickname plus a generic greeting/i);
  assert.match(activation, /incoming message is brief/i);
});
