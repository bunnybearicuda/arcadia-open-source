export type MemoryScope = "private" | "shared";
export type MemoryKind = "core" | "episodic";
export type MemoryAuthor = "companion" | "human" | "extractor";

export type Memory = {
  id: string;
  body: string;
  scope: MemoryScope;
  kind: MemoryKind;
  companion_id: string | null;
  author: MemoryAuthor;
  importance: number;
  recall_count: number;
  created_at: string;
  source_thread_id: string | null;
  forgotten_at: string | null;
  notion_page_id: string | null;
};

export type Companion = {
  id: string;
  slug: string;
  name: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  accent: string;
  voice_id: string | null;
};

export type StoredMessage = {
  id: string;
  seq: number;
  role: "user" | "assistant";
  companion_id: string | null;
  content: unknown[];
  created_at: string;
};
