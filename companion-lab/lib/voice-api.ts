function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function elevenLabsKey(request: Request) {
  return (request.headers.get("x-companion-elevenlabs-key") || "").trim().slice(0, 1000);
}

async function elevenLabsError(response: Response) {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw) as {
      detail?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.detail === "string") return parsed.detail;
    return parsed.detail?.message || parsed.message || `ElevenLabs returned ${response.status}.`;
  } catch {
    return raw.slice(0, 400) || `ElevenLabs returned ${response.status}.`;
  }
}

export async function handleVoiceApi(request: Request): Promise<Response> {
  const key = elevenLabsKey(request);
  if (!key) return json({ error: "Connect an ElevenLabs API key first." }, 409);

  if (request.method === "GET") {
    const action = new URL(request.url).searchParams.get("action") || "voices";
    const endpoint =
      action === "subscription"
        ? "https://api.elevenlabs.io/v1/user/subscription"
        : "https://api.elevenlabs.io/v2/voices?page_size=100&sort=name";
    const response = await fetch(endpoint, {
      headers: { "xi-api-key": key },
    });
    if (!response.ok) return json({ error: await elevenLabsError(response) }, response.status);
    const payload = await response.json();
    if (action === "subscription") {
      const subscription = payload as {
        tier?: string;
        status?: string;
        character_count?: number;
        character_limit?: number;
        current_overage?: { amount?: string; currency?: string };
      };
      return json({
        subscription: {
          tier: subscription.tier || "unknown",
          status: subscription.status || "unknown",
          characterCount: Number(subscription.character_count) || 0,
          characterLimit: Number(subscription.character_limit) || 0,
          currentOverage: Number(subscription.current_overage?.amount) || 0,
          currency: subscription.current_overage?.currency || "usd",
        },
      });
    }
    const voices = (
      payload as {
        voices?: Array<{
          voice_id?: string;
          name?: string;
          category?: string;
          preview_url?: string | null;
        }>;
      }
    ).voices || [];
    return json({
      voices: voices
        .filter((voice) => Boolean(voice.voice_id))
        .map((voice) => ({
          id: voice.voice_id,
          name: voice.name || voice.voice_id,
          category: voice.category || "voice",
          previewUrl: voice.preview_url || null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  }

  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const body = (await request.json()) as {
    text?: unknown;
    voiceId?: unknown;
    modelId?: unknown;
    stability?: unknown;
    similarityBoost?: unknown;
    style?: unknown;
    speakerBoost?: unknown;
    speed?: unknown;
    overrideVoiceSettings?: unknown;
  };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const voiceId = typeof body.voiceId === "string" ? body.voiceId.trim() : "";
  const modelId =
    typeof body.modelId === "string" && body.modelId.trim()
      ? body.modelId.trim()
      : "eleven_flash_v2_5";
  if (!text || text.length > 40_000) {
    return json({ error: "Read-aloud text must contain between 1 and 40,000 characters." }, 400);
  }
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(voiceId)) {
    return json({ error: "Choose an ElevenLabs voice first." }, 400);
  }
  const setting = (
    value: unknown,
    fallback: number,
    minimum = 0,
    maximum = 1,
  ) => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed)
      ? Math.min(maximum, Math.max(minimum, parsed))
      : fallback;
  };
  const voiceSettings: {
    stability: number;
    similarity_boost: number;
    style: number;
    use_speaker_boost: boolean;
    speed?: number;
  } = {
    stability: setting(body.stability, 0.5),
    similarity_boost: setting(body.similarityBoost, 0.75),
    style: setting(body.style, 0),
    use_speaker_boost:
      typeof body.speakerBoost === "boolean" ? body.speakerBoost : true,
  };
  if (modelId !== "eleven_v3") {
    voiceSettings.speed = setting(body.speed, 1, 0.7, 1.2);
  }

  const requestBody: {
    text: string;
    model_id: string;
    voice_settings?: typeof voiceSettings;
  } = {
    text,
    model_id: modelId,
  };
  if (body.overrideVoiceSettings === true) {
    requestBody.voice_settings = voiceSettings;
  }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        accept: "audio/mpeg",
        "content-type": "application/json",
        "xi-api-key": key,
      },
      body: JSON.stringify(requestBody),
    },
  );
  if (!response.ok) return json({ error: await elevenLabsError(response) }, response.status);

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("audio/")) {
    return json(
      { error: "ElevenLabs returned something other than playable audio." },
      502,
    );
  }
  const audio = await response.arrayBuffer();
  if (audio.byteLength < 512) {
    return json(
      { error: "ElevenLabs returned an incomplete audio clip. Try the voice again." },
      502,
    );
  }
  const headers = new Headers({
    "cache-control": "no-store",
    "content-length": String(audio.byteLength),
    "content-type": contentType,
  });
  const characterCost = response.headers.get("character-cost");
  if (characterCost) headers.set("x-character-cost", characterCost);
  return new Response(audio, { status: 200, headers });
}
