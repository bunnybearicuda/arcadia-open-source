import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPrivateSupabaseKey,
  supabaseApiHeaders,
  supabaseKeyKind,
} from "../lib/supabase-auth.ts";

function jwt(role) {
  const payload = Buffer.from(JSON.stringify({ role })).toString("base64url");
  return `header.${payload}.signature`;
}

test("identifies public and private Supabase key types", () => {
  assert.equal(supabaseKeyKind("sb_secret_example"), "secret");
  assert.equal(supabaseKeyKind("sb_publishable_example"), "publishable");
  assert.equal(supabaseKeyKind(jwt("service_role")), "service_role");
  assert.equal(supabaseKeyKind(jwt("anon")), "anon");
});

test("rejects keys that would run as anon", () => {
  assert.throws(() => assertPrivateSupabaseKey("sb_publishable_example"), /publishable\/anon/);
  assert.throws(() => assertPrivateSupabaseKey(jwt("anon")), /publishable\/anon/);
});

test("uses the correct REST headers for current and legacy private keys", () => {
  const secretHeaders = supabaseApiHeaders("sb_secret_example");
  assert.equal(secretHeaders.apikey, "sb_secret_example");
  assert.equal("authorization" in secretHeaders, false);

  const legacyKey = jwt("service_role");
  const legacyHeaders = supabaseApiHeaders(legacyKey);
  assert.equal(legacyHeaders.apikey, legacyKey);
  assert.equal(legacyHeaders.authorization, `Bearer ${legacyKey}`);
});
