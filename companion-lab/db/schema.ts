import { sql } from "drizzle-orm";
import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const companions = sqliteTable("companions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tagline: text("tagline").notNull().default(""),
  identity: text("identity").notNull().default(""),
  traits: text("traits").notNull().default(""),
  boundaries: text("boundaries").notNull().default(""),
  voiceNotes: text("voice_notes").notNull().default(""),
  identitySource: text("identity_source").notNull().default("custom"),
  customInstructions: text("custom_instructions").notNull().default(""),
  identityFileName: text("identity_file_name").notNull().default(""),
  identityFileContent: text("identity_file_content").notNull().default(""),
  provider: text("provider").notNull().default("anthropic"),
  model: text("model").notNull().default("claude-sonnet-4-5"),
  monthlyCap: real("monthly_cap").notNull().default(5),
  perMessageCap: real("per_message_cap").notNull().default(0.25),
  accent: text("accent").notNull().default("#55bfff"),
  companionBubbleColor: text("companion_bubble_color").notNull().default("#0f4c46"),
  userBubbleColor: text("user_bubble_color").notNull().default("#6d3f9b"),
  autonomy: text("autonomy").notNull().default("manual"),
  version: integer("version").notNull().default(1),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  companionId: text("companion_id").notNull(),
  kind: text("kind").notNull().default("solo"),
  title: text("title").notNull().default("New conversation"),
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const deletedConversations = sqliteTable("deleted_conversations", {
  id: text("id").primaryKey(),
  deletedAt: text("deleted_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  companionId: text("companion_id"),
  speakerId: text("speaker_id"),
  speakerName: text("speaker_name"),
  audienceJson: text("audience_json"),
  replyToMessageId: text("reply_to_message_id"),
  turnId: text("turn_id"),
  role: text("role").notNull(),
  contentJson: text("content_json").notNull(),
  provider: text("provider"),
  model: text("model"),
  status: text("status").notNull().default("complete"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: real("cost_usd"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  messageId: text("message_id"),
  conversationId: text("conversation_id").notNull(),
  storageKey: text("storage_key").notNull(),
  filename: text("filename").notNull(),
  mediaType: text("media_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const conversationMembers = sqliteTable(
  "conversation_members",
  {
    conversationId: text("conversation_id").notNull(),
    companionId: text("companion_id").notNull(),
    position: integer("position").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.companionId] })],
);

export const appSettings = sqliteTable("app_settings", {
  id: text("id").primaryKey(),
  monthlyBudget: real("monthly_budget").notNull().default(5),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const userProfiles = sqliteTable("user_profiles", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull().default(""),
  relationship: text("relationship").notNull().default(""),
  profileText: text("profile_text").notNull().default(""),
  notionSource: text("notion_source").notNull().default(""),
  notionSourceName: text("notion_source_name").notNull().default(""),
  notionLastSyncedAt: text("notion_last_synced_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("kian"),
  scope: text("scope").notNull().default("private"),
  category: text("category").notNull().default("memory"),
  content: text("content").notNull(),
  source: text("source").notNull().default("manual"),
  sourceRef: text("source_ref"),
  sourceUrl: text("source_url"),
  priority: integer("priority").notNull().default(1),
  pinned: integer("pinned").notNull().default(0),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const memoryCheckpoints = sqliteTable("memory_checkpoints", {
  conversationId: text("conversation_id").primaryKey(),
  lastMessageRowid: integer("last_message_rowid").notNull().default(0),
  lastProcessedAt: text("last_processed_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const memoryRuns = sqliteTable("memory_runs", {
  id: text("id").primaryKey(),
  companionId: text("companion_id").notNull(),
  conversationId: text("conversation_id"),
  source: text("source").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: real("cost_usd"),
  itemCount: integer("item_count").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const memoryImports = sqliteTable("memory_imports", {
  id: text("id").primaryKey(),
  companionId: text("companion_id").notNull(),
  filename: text("filename").notNull(),
  mediaType: text("media_type").notNull().default("application/octet-stream"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  storageKey: text("storage_key").notNull(),
  totalParts: integer("total_parts").notNull().default(1),
  completedParts: integer("completed_parts").notNull().default(0),
  characterCount: integer("character_count").notNull().default(0),
  importedCount: integer("imported_count").notNull().default(0),
  sharedCount: integer("shared_count").notNull().default(0),
  privateCount: integer("private_count").notNull().default(0),
  truncated: integer("truncated").notNull().default(0),
  status: text("status").notNull().default("ready"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const memoryMaintenance = sqliteTable("memory_maintenance", {
  id: text("id").primaryKey(),
  lastReviewedAt: text("last_reviewed_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const memoryNotionLinks = sqliteTable("memory_notion_links", {
  memoryId: text("memory_id").primaryKey(),
  notionPageId: text("notion_page_id").notNull(),
  notionBlockId: text("notion_block_id"),
  sourceId: text("source_id").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
