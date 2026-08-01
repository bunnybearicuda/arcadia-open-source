import type { CompanionApiEnv } from "./companion-api";

// Web Push (PDF Phase 10). VAPID keys are generated once and kept in D1 so the
// public key stays stable for every device that subscribes; the private key
// never leaves the worker.
const CREATE_PUSH_SUBSCRIPTIONS = `
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_sent_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0
  )
`;

const CREATE_PUSH_KEYS = `
  CREATE TABLE IF NOT EXISTS push_keys (
    id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function initializePushStorage(database: D1Database) {
  await database.prepare(CREATE_PUSH_SUBSCRIPTIONS).run();
  await database.prepare(CREATE_PUSH_KEYS).run();
}

async function loadOrCreateVapidKeys(database: D1Database) {
  await initializePushStorage(database);
  const existing = await database
    .prepare("SELECT public_key, private_key FROM push_keys WHERE id = 'vapid'")
    .first<{ public_key: string; private_key: string }>();
  if (existing) return existing;

  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicRaw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = base64UrlEncode(publicRaw);
  const privateKey = JSON.stringify(privateJwk);
  await database
    .prepare(
      `INSERT INTO push_keys (id, public_key, private_key) VALUES ('vapid', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(publicKey, privateKey)
    .run();
  const stored = await database
    .prepare("SELECT public_key, private_key FROM push_keys WHERE id = 'vapid'")
    .first<{ public_key: string; private_key: string }>();
  return stored || { public_key: publicKey, private_key: privateKey };
}

// Signs the VAPID JWT that authorizes this server to push to a given origin.
async function vapidAuthorization(
  privateKeyJwk: string,
  publicKey: string,
  audience: string,
) {
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(privateKeyJwk) as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const claims = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: "mailto:push@companion-lab.invalid",
      }),
    ),
  );
  const unsigned = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned),
  );
  return `vapid t=${unsigned}.${base64UrlEncode(signature)}, k=${publicKey}`;
}

// RFC 8291 aes128gcm payload encryption.
async function encryptPayload(
  payload: string,
  p256dh: string,
  auth: string,
) {
  const clientPublic = base64UrlDecode(p256dh);
  const authSecret = base64UrlDecode(auth);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const serverKeys = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const serverPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", serverKeys.publicKey),
  );
  const clientKey = await crypto.subtle.importKey(
    "raw",
    clientPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: clientKey },
      serverKeys.privateKey,
      256,
    ),
  );

  const hkdf = async (
    ikm: Uint8Array,
    hkdfSalt: Uint8Array,
    info: Uint8Array,
    length: number,
  ) => {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
      "deriveBits",
    ]);
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: hkdfSalt, info },
        key,
        length * 8,
      ),
    );
  };

  const concat = (...parts: Uint8Array[]) => {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  };

  const encoder = new TextEncoder();
  const keyInfo = concat(
    encoder.encode("WebPush: info\0"),
    clientPublic,
    serverPublicRaw,
  );
  const ikm = await hkdf(sharedSecret, authSecret, keyInfo, 32);
  const contentEncryptionKey = await hkdf(
    ikm,
    salt,
    encoder.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    ikm,
    salt,
    encoder.encode("Content-Encoding: nonce\0"),
    12,
  );

  const aesKey = await crypto.subtle.importKey(
    "raw",
    contentEncryptionKey,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  // A single record: payload followed by the 0x02 padding delimiter.
  const plaintext = concat(encoder.encode(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(
    salt,
    recordSize,
    new Uint8Array([serverPublicRaw.length]),
    serverPublicRaw,
    ciphertext,
  );
}

export async function sendPushToAll(
  database: D1Database,
  payload: PushPayload,
) {
  const keys = await loadOrCreateVapidKeys(database);
  const subscriptions = await database
    .prepare(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions
       WHERE failure_count < 5`,
    )
    .all<{ endpoint: string; p256dh: string; auth: string }>();
  const rows = subscriptions.results || [];
  if (!rows.length) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const audience = new URL(row.endpoint).origin;
      const authorization = await vapidAuthorization(
        keys.private_key,
        keys.public_key,
        audience,
      );
      const body = await encryptPayload(
        JSON.stringify(payload),
        row.p256dh,
        row.auth,
      );
      const response = await fetch(row.endpoint, {
        method: "POST",
        headers: {
          authorization,
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: "86400",
        },
        body,
      });
      if (response.ok || response.status === 201) {
        sent += 1;
        await database
          .prepare(
            `UPDATE push_subscriptions
             SET last_sent_at = CURRENT_TIMESTAMP, failure_count = 0
             WHERE endpoint = ?`,
          )
          .bind(row.endpoint)
          .run();
        continue;
      }
      failed += 1;
      // 404/410 mean the browser dropped the subscription for good.
      if (response.status === 404 || response.status === 410) {
        await database
          .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
          .bind(row.endpoint)
          .run();
      } else {
        await database
          .prepare(
            `UPDATE push_subscriptions
             SET failure_count = failure_count + 1
             WHERE endpoint = ?`,
          )
          .bind(row.endpoint)
          .run();
      }
    } catch {
      failed += 1;
    }
  }
  return { sent, failed };
}

export async function handlePushApi(
  request: Request,
  env: CompanionApiEnv,
): Promise<Response> {
  try {
    await initializePushStorage(env.DB);

    if (request.method === "GET") {
      const keys = await loadOrCreateVapidKeys(env.DB);
      const count = await env.DB
        .prepare("SELECT COUNT(*) AS total FROM push_subscriptions")
        .first<{ total: number }>();
      return json({
        publicKey: keys.public_key,
        deviceCount: Number(count?.total) || 0,
      });
    }

    if (request.method === "POST") {
      const body = (await request.json()) as {
        endpoint?: unknown;
        keys?: { p256dh?: unknown; auth?: unknown };
        label?: unknown;
        test?: unknown;
      };
      if (body.test === true) {
        const result = await sendPushToAll(env.DB, {
          title: "Companion Lab",
          body: "Notifications are working.",
          tag: "companion-lab-test",
        });
        return json(result);
      }
      const endpoint =
        typeof body.endpoint === "string" ? body.endpoint.trim().slice(0, 800) : "";
      const p256dh =
        typeof body.keys?.p256dh === "string" ? body.keys.p256dh.trim() : "";
      const auth = typeof body.keys?.auth === "string" ? body.keys.auth.trim() : "";
      if (!endpoint || !p256dh || !auth) {
        return json({ error: "That push subscription is incomplete." }, 400);
      }
      await env.DB
        .prepare(
          `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET
             p256dh = excluded.p256dh,
             auth = excluded.auth,
             label = excluded.label,
             failure_count = 0`,
        )
        .bind(
          endpoint,
          p256dh,
          auth,
          typeof body.label === "string" ? body.label.slice(0, 120) : "",
        )
        .run();
      return json({ ok: true }, 201);
    }

    if (request.method === "DELETE") {
      const endpoint =
        (new URL(request.url).searchParams.get("endpoint") || "").trim().slice(0, 800);
      if (!endpoint) return json({ error: "Choose a device to remove." }, 400);
      await env.DB
        .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
        .bind(endpoint)
        .run();
      return json({ ok: true });
    }

    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Push setup failed." },
      500,
    );
  }
}
