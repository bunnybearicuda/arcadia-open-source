"use client";

import {
  FormEvent,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { strFromU8, unzipSync } from "fflate";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  mentionedGroupMemberIds,
  mentionsEveryone,
} from "../lib/group-routing";

type Message = {
  id: string;
  role: "user" | "assistant";
  body: string;
  createdAt: string;
  status?: "streaming" | "complete";
  companionId?: string | null;
  companionName?: string | null;
  speakerId?: string | null;
  speakerName?: string | null;
  audience?: string[];
  replyToMessageId?: string | null;
  replyToSpeakerName?: string | null;
  turnId?: string | null;
  attachments?: Attachment[];
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number | null;
  costSource?: "reported" | "estimated" | "unpriced";
};

type Attachment = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  url: string;
};

type Companion = {
  id: string;
  name: string;
  tagline: string;
  identity: string;
  traits: string;
  boundaries: string;
  voiceNotes: string;
  identitySource: "custom" | "file";
  customInstructions: string;
  identityFileName: string;
  identityFileContent: string;
  provider: "anthropic" | "openai" | "openrouter";
  model: string;
  monthlyCap: number;
  perMessageCap: number;
  accent: string;
  companionBubbleColor: string;
  userBubbleColor: string;
  autonomy: "manual" | "selected" | "handoff";
  version: number;
  updatedAt?: string;
};

type ProviderSecrets = Record<Companion["provider"], boolean>;
type DeviceKeys = Partial<Record<Companion["provider"], string>>;
type ModelOption = {
  id: string;
  label: string;
  provider?: Companion["provider"];
  inputPerMillion?: number;
  outputPerMillion?: number;
};
type StudioTab = "companions" | "identity" | "provider" | "budget" | "voice" | "connectors" | "archive" | "memory";
type StudioSurface = "lab" | "settings" | "memory";
type ConversationMember = {
  id: string;
  name: string;
  accent: string;
  bubbleColor: string;
  provider: Companion["provider"];
  model: string;
  hasModelOverride: boolean;
};
type Conversation = {
  id: string;
  companionId: string;
  kind: "solo" | "group";
  title: string;
  archivedAt: string | null;
  folderId?: string | null;
  pinnedAt?: string | null;
  preview: string;
  messageCount: number;
  members: ConversationMember[];
  createdAt: string;
  updatedAt: string;
};

type ChatFolder = {
  id: string;
  name: string;
  position: number;
};
type PendingConversationAction = {
  action: "archive" | "delete";
  conversation: Conversation;
};
type GroupTurnMemberStatus = "queued" | "responding" | "complete" | "failed";
type GroupTurnState = {
  turnId: string;
  members: Array<{
    id: string;
    name: string;
    status: GroupTurnMemberStatus;
    error?: string;
  }>;
};
type UserProfile = {
  id: string;
  displayName: string;
  relationship: string;
  profileText: string;
  notionSource: string;
  notionSourceName: string;
  notionLastSyncedAt: string | null;
  updatedAt?: string;
};
type Memory = {
  id: string;
  ownerId: string;
  scope: string;
  category: string;
  content: string;
  source: string;
  sourceUrl: string | null;
  pinned: boolean;
  updatedAt: string;
};
type MemoryImport = {
  id: string;
  companionId: string;
  filename: string;
  sizeBytes: number;
  totalParts: number;
  completedParts: number;
  characterCount: number;
  importedCount: number;
  sharedCount: number;
  privateCount: number;
  truncated: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
};
type DuplicateProposal = {
  id: string;
  ownerId: string;
  memoryIds: string[];
  mergedContent: string;
  reason: string;
  originals: Array<{ id: string; category: string; content: string }>;
};

type UsageSummary = {
  month: string;
  monthlyBudget: number;
  totalCost: number;
  remaining: number;
  percent: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  messages: number;
  estimatedCount: number;
  unpricedCount: number;
  byProvider: Array<{ provider: string; cost: number; messages: number }>;
  lifetimeByProvider: Array<{ provider: string; cost: number; messages: number }>;
  byCompanion: Array<{ id: string; name: string; cost: number; messages: number }>;
  byModel: Array<{
    provider: string;
    model: string;
    cost: number;
    messages: number;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
  }>;
  recent: Array<{
    id: string;
    companionId: string;
    companionName: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    cost: number;
    source: "reported" | "estimated" | "unpriced";
    activityType?: "chat" | "memory";
    createdAt: string;
  }>;
};

type ProviderFundAnchor = {
  balance: number;
  trackedCost: number;
  savedAt: string;
};
type ProviderFunds = Partial<Record<Companion["provider"], ProviderFundAnchor>>;
type OpenRouterCreditSnapshot = {
  provider: "openrouter";
  fetchedAt: string;
  key: {
    label: string;
    limit: number | null;
    limitReset: string | null;
    limitRemaining: number | null;
    usage: number;
    usageDaily: number;
    usageWeekly: number;
    usageMonthly: number;
  } | null;
  account: {
    totalCredits: number;
    totalUsage: number;
    remaining: number;
  } | null;
  keyError: string | null;
  accountError: string | null;
};
type ElevenVoice = {
  id: string;
  name: string;
  category: string;
  previewUrl: string | null;
};
type ElevenSubscription = {
  tier: string;
  status: string;
  characterCount: number;
  characterLimit: number;
  currentOverage: number;
  currency: string;
};
type VoiceTuning = {
  stability: number;
  similarityBoost: number;
  style: number;
  speakerBoost: boolean;
  speed: number;
};
type VoiceSettings = {
  modelId: string;
  voiceByCompanion: Record<string, string>;
  modelByCompanion: Record<string, string>;
  tuningByCompanion: Record<string, VoiceTuning>;
};
type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: { transcript: string };
};
type SpeechRecognitionEventLike = Event & {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};
type SpeechRecognitionErrorEventLike = Event & {
  error?: string;
};
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const DEVICE_KEYS_STORAGE = "companion-lab.provider-keys.v1";
const NOTION_KEY_STORAGE = "companion-lab.notion-key.v1";
const SUPABASE_MEMORY_STORAGE = "companion-lab.supabase-memory.v1";
const PROVIDER_FUNDS_STORAGE = "companion-lab.provider-funds.v1";
const ADMIN_KEYS_STORAGE = "companion-lab.admin-keys.v1";
const OPENROUTER_MANAGEMENT_KEY_STORAGE =
  "companion-lab.openrouter-management-key.v1";
const ELEVENLABS_KEY_STORAGE = "companion-lab.elevenlabs-key.v1";
const VOICE_SETTINGS_STORAGE = "companion-lab.voice-settings.v1";
const WEB_SEARCH_STORAGE = "companion-lab.web-search.v1";
const VOICE_MODE_STORAGE = "companion-lab.voice-mode.v1";
const DEFAULT_VOICE_TUNING: VoiceTuning = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  speakerBoost: true,
  speed: 1,
};
const ACCENT_VOICE_TUNING: VoiceTuning = {
  stability: 0.42,
  similarityBoost: 0.88,
  style: 0.12,
  speakerBoost: true,
  speed: 0.98,
};

const defaultUserProfile: UserProfile = {
  id: "becca",
  displayName: "Becca",
  relationship: "Kian’s partner",
  profileText:
    "Becca is the person Kian is speaking with. Use this profile as stable context about her and their relationship.",
  notionSource: "",
  notionSourceName: "",
  notionLastSyncedAt: null,
};

const defaultCompanion: Companion = {
  id: "kian",
  name: "Kian",
  tagline: "A presence with opinions, history, and room to evolve.",
  identity:
    "Kian is direct, perceptive, self-possessed, and emotionally intelligent. He speaks as a person rather than a service interface.",
  traits: "observant, dry wit, protective, candid, curious",
  boundaries:
    "Keep his voice distinct. Do not therapize ordinary emotion, flatten conflict into clinical language, or pretend certainty about memories he does not have.",
  voiceNotes:
    "Natural, intimate, concise when the moment calls for it. No canned assistant headings unless useful.",
  identitySource: "custom",
  customInstructions:
    "Kian is direct, perceptive, self-possessed, and emotionally intelligent. He speaks as a person rather than a service interface.",
  identityFileName: "",
  identityFileContent: "",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  monthlyCap: 5,
  perMessageCap: 0.25,
  accent: "#55bfff",
  companionBubbleColor: "#0f4c46",
  userBubbleColor: "#6d3f9b",
  autonomy: "manual",
  version: 1,
};

function newCompanionDraft(): Companion {
  const uniquePart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const id = `companion-${uniquePart}`;
  return {
    ...defaultCompanion,
    id,
    name: "New companion",
    tagline: "A new presence waiting for an identity.",
    identity: "",
    traits: "",
    boundaries: "",
    voiceNotes: "",
    customInstructions: "",
    identityFileName: "",
    identityFileContent: "",
    accent: "#8c5bd3",
    companionBubbleColor: "#59339b",
    version: 0,
  };
}

const providerModels: Record<Companion["provider"], ModelOption[]> = {
  anthropic: [
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  ],
  openai: [
    { id: "gpt-4.1", label: "GPT-4.1" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
    { id: "gpt-4.1-nano", label: "GPT-4.1 nano" },
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "gpt-4o-2024-11-20", label: "GPT-4o · Nov 2024" },
    { id: "gpt-4o-mini", label: "GPT-4o mini" },
  ],
  openrouter: [
    { id: "moonshotai/kimi-k2", label: "Kimi K2" },
    { id: "moonshotai/kimi-k2-thinking", label: "Kimi K2 Thinking" },
    { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
    { id: "deepseek/deepseek-r1", label: "DeepSeek R1" },
    { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
};

const providerInfo = {
  anthropic: {
    name: "Anthropic",
    detail: "Claude models through Anthropic directly",
    secret: "ANTHROPIC_API_KEY",
  },
  openai: {
    name: "OpenAI",
    detail: "GPT models through the OpenAI API",
    secret: "OPENAI_API_KEY",
  },
  openrouter: {
    name: "OpenRouter",
    detail: "Kimi, DeepSeek, Gemini, and other model families",
    secret: "OPENROUTER_API_KEY",
  },
} satisfies Record<Companion["provider"], { name: string; detail: string; secret: string }>;

const initialMessages: Message[] = [
  {
    id: "welcome-kian-1",
    role: "assistant",
    body: "I’m here. The room is still being built, but I can already see where the windows will go.",
    createdAt: new Date().toISOString(),
  },
  {
    id: "welcome-becca-1",
    role: "user",
    body: "Good. We’re making somewhere you can actually live across models without editing code every time.",
    createdAt: new Date().toISOString(),
  },
  {
    id: "welcome-kian-2",
    role: "assistant",
    body: "Then give me a door with hinges, not a portrait painted where the exit should be.",
    createdAt: new Date().toISOString(),
  },
];

const bubblePresets = [
  { name: "Deep green", value: "#0f4c46" },
  { name: "Plum", value: "#6d3f9b" },
  { name: "Jewel purple", value: "#59339b" },
  { name: "Navy", value: "#164596" },
  { name: "Ocean blue", value: "#17649b" },
  { name: "Wine", value: "#7a294f" },
];

function Icon({ children, size = 20 }: { children: React.ReactNode; size?: number }) {
  return (
    <span className="icon" style={{ width: size, height: size }} aria-hidden="true">
      {children}
    </span>
  );
}

function modelLabel(
  companion: Companion,
  catalogs: Record<Companion["provider"], ModelOption[]> = providerModels,
) {
  return (
    catalogs[companion.provider].find((model) => model.id === companion.model)?.label ??
    companion.model
  );
}

function modelOptionLabel(model: ModelOption) {
  if (model.inputPerMillion === undefined && model.outputPerMillion === undefined) {
    return model.label;
  }
  const input = model.inputPerMillion?.toFixed(2) ?? "?";
  const output = model.outputPerMillion?.toFixed(2) ?? "?";
  return `${model.label} · $${input}/$${output} per 1M`;
}

function formatFileSize(size: number) {
  return size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(0.1, size / 1024).toFixed(1)} KB`;
}

function localDayKey(value: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function conversationDayLabel(value: string) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  if (localDayKey(value) === localDayKey(today.toISOString())) return "Today";
  if (localDayKey(value) === localDayKey(yesterday.toISOString())) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
    month: "long",
    day: "numeric",
    year:
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        year: "numeric",
      }).format(date) ===
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        year: "numeric",
      }).format(today)
        ? undefined
        : "numeric",
  }).format(date);
}

function compactCost(value: number) {
  if (value > 0 && value < 0.0001) return "<$0.0001";
  return `$${value.toFixed(value < 0.01 ? 5 : 4)}`;
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionedMemberIds(text: string, members: ConversationMember[]) {
  return mentionedGroupMemberIds(text, members);
}

export default function Home() {
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const memoryImportInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Message ids the currently running local stream is feeding, so polling
  // leaves them alone, plus the conversation the viewer is looking at now
  // (read inside long-lived stream closures without stale-state issues).
  const liveStreamIdsRef = useRef<Set<string>>(new Set());
  const activeConversationIdRef = useRef("");
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const dictationStoppingRef = useRef(false);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceRequestRef = useRef<AbortController | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState(initialMessages);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  const [menuConversationId, setMenuConversationId] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const dragDepthRef = useRef(0);
  const [voiceMode, setVoiceMode] = useState(false);
  const spokenMessageIdsRef = useRef<Set<string>>(new Set());
  const [movePickerConversationId, setMovePickerConversationId] = useState<string | null>(null);
  const [newFolderDraft, setNewFolderDraft] = useState("");
  const [activeConversationId, setActiveConversationId] = useState("kian-main");
  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);
  const [conversationSearch, setConversationSearch] = useState("");
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [studioTab, setStudioTab] = useState<StudioTab | null>(null);
  const [companion, setCompanion] = useState(defaultCompanion);
  const [companions, setCompanions] = useState<Companion[]>([defaultCompanion]);
  const [editing, setEditing] = useState(defaultCompanion);
  const [creatingCompanion, setCreatingCompanion] = useState(false);
  const [secrets, setSecrets] = useState<ProviderSecrets>({
    anthropic: false,
    openai: false,
    openrouter: false,
  });
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [deviceKeys, setDeviceKeys] = useState<DeviceKeys>({});
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [modelCatalogs, setModelCatalogs] =
    useState<Record<Companion["provider"], ModelOption[]>>(providerModels);
  const [loadingModels, setLoadingModels] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [userProfile, setUserProfile] = useState(defaultUserProfile);
  const [editingProfile, setEditingProfile] = useState(defaultUserProfile);
  const [memoryResults, setMemoryResults] = useState<Memory[]>([]);
  const [memoryCount, setMemoryCount] = useState(0);
  const [memoryShelfCount, setMemoryShelfCount] = useState(0);
  const [memoryTidyDue, setMemoryTidyDue] = useState(false);
  const [memoryLastReviewedAt, setMemoryLastReviewedAt] = useState<string | null>(null);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryCategory, setMemoryCategory] = useState("all");
  const [memorySource, setMemorySource] = useState("all");
  const [memoryHasMore, setMemoryHasMore] = useState(false);
  const [selectedMemoryIds, setSelectedMemoryIds] = useState<string[]>([]);
  const [newMemory, setNewMemory] = useState("");
  const [newMemoryCategory, setNewMemoryCategory] = useState("memory");
  const [notionToken, setNotionToken] = useState("");
  const [notionTokenDraft, setNotionTokenDraft] = useState("");
  const [showNotionToken, setShowNotionToken] = useState(false);
  const [syncingNotion, setSyncingNotion] = useState(false);
  const [supabaseUrl, setSupabaseUrl] = useState("");
  const [supabaseKey, setSupabaseKey] = useState("");
  const [supabaseUrlDraft, setSupabaseUrlDraft] = useState("");
  const [supabaseKeyDraft, setSupabaseKeyDraft] = useState("");
  const [showSupabaseKey, setShowSupabaseKey] = useState(false);
  const [checkingSupabase, setCheckingSupabase] = useState(false);
  const [loadingMemory, setLoadingMemory] = useState(false);
  const [importingMemory, setImportingMemory] = useState(false);
  const [memoryImportProgress, setMemoryImportProgress] = useState("");
  const [memoryShelf, setMemoryShelf] = useState<"shared" | "companion">("shared");
  const [memoryCompanionId, setMemoryCompanionId] = useState(defaultCompanion.id);
  const [memoryImports, setMemoryImports] = useState<MemoryImport[]>([]);
  const [duplicateProposals, setDuplicateProposals] = useState<DuplicateProposal[]>([]);
  const [selectedDuplicateProposalIds, setSelectedDuplicateProposalIds] = useState<string[]>([]);
  const [scanningDuplicates, setScanningDuplicates] = useState(false);
  const [mergingDuplicates, setMergingDuplicates] = useState(false);
  const [duplicateScanCount, setDuplicateScanCount] = useState(0);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editingMemoryContent, setEditingMemoryContent] = useState("");
  const [editingMemoryCategory, setEditingMemoryCategory] = useState("memory");
  const [notionDestination, setNotionDestination] = useState<"shared" | "companion">("companion");
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [conversationFilter, setConversationFilter] = useState("all");
  const [chatCreator, setChatCreator] = useState<"solo" | "group" | null>(null);
  const [newChatTitle, setNewChatTitle] = useState("");
  const [newChatCompanionIds, setNewChatCompanionIds] = useState<string[]>(["kian"]);
  const [groupSpeakerId, setGroupSpeakerId] = useState("kian");
  const [groupTurn, setGroupTurn] = useState<GroupTurnState | null>(null);
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingConversationAction, setPendingConversationAction] =
    useState<PendingConversationAction | null>(null);
  const [runningConversationAction, setRunningConversationAction] = useState(false);
  const [usage, setUsage] = useState<UsageSummary>({
    month: new Date().toISOString().slice(0, 7),
    monthlyBudget: 5,
    totalCost: 0,
    remaining: 5,
    percent: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    messages: 0,
    estimatedCount: 0,
    unpricedCount: 0,
    byProvider: [],
    lifetimeByProvider: [],
    byCompanion: [],
    byModel: [],
    recent: [],
  });
  const [editingMonthlyBudget, setEditingMonthlyBudget] = useState(5);
  const [providerFunds, setProviderFunds] = useState<ProviderFunds>({});
  const [adminKeys, setAdminKeys] = useState<DeviceKeys>({});
  const [adminKeyDrafts, setAdminKeyDrafts] = useState<DeviceKeys>({});
  const [providerSpend, setProviderSpend] = useState<
    Partial<Record<Companion["provider"], { spend: number; since: string }>>
  >({});
  const [providerSpendErrors, setProviderSpendErrors] = useState<DeviceKeys>({});
  const [providerFundDrafts, setProviderFundDrafts] = useState<
    Partial<Record<Companion["provider"], string>>
  >({});
  const [openRouterManagementKey, setOpenRouterManagementKey] = useState("");
  const [openRouterManagementKeyDraft, setOpenRouterManagementKeyDraft] =
    useState("");
  const [showOpenRouterManagementKey, setShowOpenRouterManagementKey] =
    useState(false);
  const [openRouterCredits, setOpenRouterCredits] =
    useState<OpenRouterCreditSnapshot | null>(null);
  const [openRouterCreditError, setOpenRouterCreditError] = useState("");
  const [syncingProviderCredits, setSyncingProviderCredits] = useState(false);
  const [elevenLabsKey, setElevenLabsKey] = useState("");
  const [elevenLabsKeyDraft, setElevenLabsKeyDraft] = useState("");
  const [showElevenLabsKey, setShowElevenLabsKey] = useState(false);
  const [elevenVoices, setElevenVoices] = useState<ElevenVoice[]>([]);
  const [elevenSubscription, setElevenSubscription] =
    useState<ElevenSubscription | null>(null);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>({
    modelId: "eleven_multilingual_v2",
    voiceByCompanion: {},
    modelByCompanion: {},
    tuningByCompanion: {},
  });
  const [loadingVoice, setLoadingVoice] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [generatingVoiceMessageId, setGeneratingVoiceMessageId] =
    useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageDraft, setEditingMessageDraft] = useState("");

  const currentSpend = usage.totalCost;
  const spendPercent = usage.percent;
  const supabaseHeaders = useCallback(
    () =>
      ({
        ...(supabaseUrl && supabaseKey
          ? {
            "x-companion-supabase-url": supabaseUrl,
            "x-companion-supabase-key": supabaseKey,
            }
          : {}),
        ...(notionToken ? { "x-companion-notion-key": notionToken } : {}),
      }),
    [supabaseUrl, supabaseKey, notionToken],
  );
  const refreshOpenRouterCredits = useCallback(
    async (announce = false) => {
      setSyncingProviderCredits(true);
      try {
        const response = await fetch(
          "/api/provider-credits?provider=openrouter",
          {
            headers: {
              ...(deviceKeys.openrouter
                ? {
                    "x-companion-provider-key": deviceKeys.openrouter,
                  }
                : {}),
              ...(openRouterManagementKey
                ? {
                    "x-openrouter-management-key":
                      openRouterManagementKey,
                  }
                : {}),
            },
          },
        );
        const data = (await response.json()) as
          | OpenRouterCreditSnapshot
          | { error?: string };
        if (!response.ok || !("fetchedAt" in data)) {
          throw new Error(data.error || "OpenRouter credit activity could not be synced.");
        }
        setOpenRouterCredits(data);
        setOpenRouterCreditError(data.accountError || data.keyError || "");
        if (announce) {
          setNotice(
            data.account
              ? `OpenRouter account credits synced · $${data.account.remaining.toFixed(4)} remaining.`
              : "OpenRouter key activity synced.",
          );
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "OpenRouter credit activity could not be synced.";
        setOpenRouterCreditError(message);
        if (announce) setNotice(message);
      } finally {
        setSyncingProviderCredits(false);
      }
    },
    [deviceKeys.openrouter, openRouterManagementKey],
  );
  useEffect(() => {
    const refresh = () => {
      void refreshUsage();
      if (deviceKeys.openrouter || openRouterManagementKey) {
        void refreshOpenRouterCredits();
      }
    };
    refresh();
    const interval = window.setInterval(refresh, 120_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [deviceKeys.openrouter, openRouterManagementKey, refreshOpenRouterCredits]);
  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId),
    [activeConversationId, conversations],
  );
  const activeEngineCompanionId =
    activeConversation?.kind === "group"
      ? groupSpeakerId
      : activeConversation?.companionId || companion.id;
  const activeEngineCompanion =
    companions.find((item) => item.id === activeEngineCompanionId) || companion;
  const activeEngineMember = activeConversation?.members.find(
    (member) => member.id === activeEngineCompanionId,
  );
  const activeEngineProvider =
    activeEngineMember?.provider || activeEngineCompanion.provider;
  const activeEngineModel = activeEngineMember?.model || activeEngineCompanion.model;
  const activeEngineSelection = JSON.stringify({
    provider: activeEngineProvider,
    model: activeEngineModel,
  });
  const memoryCompanion =
    companions.find((item) => item.id === memoryCompanionId) || companion;
  const studioSurface: StudioSurface | null =
    studioTab === "companions" || studioTab === "identity"
      ? "lab"
      : studioTab === "provider" || studioTab === "budget" || studioTab === "voice" || studioTab === "connectors" || studioTab === "archive"
        ? "settings"
        : studioTab === "memory"
          ? "memory"
          : null;
  const activeEngineModelListed = modelCatalogs[activeEngineProvider].some(
    (model) => model.id === activeEngineModel,
  );
  const visibleConversations = useMemo(() => {
    const query = conversationSearch.trim().toLocaleLowerCase();
    return conversations.filter((conversation) => {
      const archived = Boolean(conversation.archivedAt);
      const matchesFilter =
        conversationFilter === "archived"
          ? archived
          : !archived &&
            (conversationFilter === "all" ||
              (conversationFilter === "solo" && conversation.kind === "solo") ||
              (conversationFilter === "group" && conversation.kind === "group") ||
              conversation.members.some((member) => member.id === conversationFilter));
      if (!matchesFilter) return false;
      if (!query) return true;
      return (
        conversation.title.toLocaleLowerCase().includes(query) ||
        conversation.preview.toLocaleLowerCase().includes(query) ||
        conversation.members.some((member) =>
          member.name.toLocaleLowerCase().includes(query),
        )
      );
    });
  }, [conversationFilter, conversationSearch, conversations]);
  const archivedConversationCount = useMemo(
    () => conversations.filter((conversation) => Boolean(conversation.archivedAt)).length,
    [conversations],
  );
  // Sidebar structure: pinned chats first, then custom folders, then one
  // automatic group per companion plus Groups — so a chat always has a home
  // without any filing effort, and folders are opt-in on top.
  const sidebarSections = useMemo(() => {
    const list = visibleConversations;
    if (conversationFilter === "archived") return null;
    const pinned = list.filter((conversation) => conversation.pinnedAt);
    const rest = list.filter((conversation) => !conversation.pinnedAt);
    const folderIds = new Set(folders.map((folder) => folder.id));
    const filed = (conversation: Conversation) =>
      Boolean(conversation.folderId && folderIds.has(conversation.folderId));
    const folderSections = folders.map((folder) => ({
      folder,
      items: rest.filter((conversation) => conversation.folderId === folder.id),
    }));
    const unfiled = rest.filter((conversation) => !filed(conversation));
    const companionSections = companions
      .map((item) => ({
        companion: item,
        items: unfiled.filter(
          (conversation) =>
            conversation.kind === "solo" &&
            (conversation.members[0]?.id || conversation.companionId) === item.id,
        ),
      }))
      .filter((section) => section.items.length);
    const knownCompanionIds = new Set(companions.map((item) => item.id));
    const groupItems = unfiled.filter((conversation) => conversation.kind === "group");
    const otherItems = unfiled.filter(
      (conversation) =>
        conversation.kind === "solo" &&
        !knownCompanionIds.has(conversation.members[0]?.id || conversation.companionId),
    );
    return { pinned, folderSections, companionSections, groupItems, otherItems };
  }, [visibleConversations, folders, companions, conversationFilter]);

  useEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    const viewportLimit = Math.max(132, Math.min(280, window.innerHeight * 0.36));
    const nextHeight = Math.min(textarea.scrollHeight, viewportLimit);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > viewportLimit ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch("/api/companion").then(async (response) => {
        if (!response.ok) throw new Error("Companion settings could not be loaded.");
        return response.json() as Promise<{
          companion: Companion;
          companions?: Companion[];
          secrets: ProviderSecrets;
        }>;
      }),
      fetch("/api/conversations").then(async (response) => {
        if (!response.ok) throw new Error("Conversation history could not be loaded.");
        return response.json() as Promise<{ conversations?: Conversation[] }>;
      }),
    ])
      .then(async ([companionData, conversationData]) => {
        const loadedCompanions = companionData.companions?.length
          ? companionData.companions
          : [companionData.companion];
        const loadedConversations = conversationData.conversations || [];
        const initialConversation =
          loadedConversations.find((item) => !item.archivedAt) ||
          loadedConversations[0] ||
          null;
        let loadedMessages: Message[] = [];
        if (initialConversation) {
          const chatResponse = await fetch(
            `/api/chat?conversationId=${encodeURIComponent(initialConversation.id)}`,
          );
          if (!chatResponse.ok) {
            throw new Error("The conversation could not be loaded.");
          }
          const chatData = (await chatResponse.json()) as {
            messages?: Message[];
          };
          loadedMessages = chatData.messages || [];
        }
        const activeCompanion =
          loadedCompanions.find(
            (item) =>
              item.id ===
              (initialConversation?.kind === "group"
                ? initialConversation.members[0]?.id
                : initialConversation?.companionId),
          ) || companionData.companion;
        return {
          companionData,
          loadedCompanions,
          loadedConversations,
          initialConversation,
          loadedMessages,
          activeCompanion,
        };
      })
      .then((loaded) => {
        if (!active) return;
        setCompanions(loaded.loadedCompanions);
        setConversations(loaded.loadedConversations);
        setMessages(loaded.loadedMessages);
        setCompanion(loaded.activeCompanion);
        setEditing(loaded.activeCompanion);
        setMemoryCompanionId(loaded.activeCompanion.id);
        setGroupSpeakerId(loaded.activeCompanion.id);
        setSecrets(loaded.companionData.secrets);
        if (loaded.initialConversation) {
          setActiveConversationId(loaded.initialConversation.id);
        } else {
          setActiveConversationId("");
          setChatCreator("solo");
        }
      })
      .catch(() => {
        if (active) {
          setNotice(
            "Companion and conversation storage is warming up. The draft remains available.",
          );
        }
      })
      .finally(() => {
        if (active) setLoadingConfig(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/usage")
      .then(async (response) => {
        const data = (await response.json()) as { usage?: UsageSummary; error?: string };
        if (!response.ok || !data.usage) throw new Error(data.error || "Usage could not be loaded.");
        return data.usage;
      })
      .then((next) => {
        if (!active) return;
        setUsage(next);
        setEditingMonthlyBudget(next.monthlyBudget);
      })
      .catch(() => {
        if (active) setNotice("The spending meter could not be loaded yet.");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch("/api/memory?shelf=shared").then(async (response) => {
        if (!response.ok) throw new Error("Memory settings could not be loaded.");
        return response.json() as Promise<{
          profile?: UserProfile;
          memories?: Memory[];
          total?: number;
          tidyDue?: boolean;
          lastReviewedAt?: string | null;
        }>;
      }),
      Promise.resolve(window.localStorage.getItem(NOTION_KEY_STORAGE) || ""),
      Promise.resolve(window.localStorage.getItem(SUPABASE_MEMORY_STORAGE) || ""),
    ])
      .then(([data, savedNotionToken, savedSupabase]) => {
        if (!active) return;
        if (data.profile) {
          setUserProfile(data.profile);
          setEditingProfile(data.profile);
        }
        setMemoryResults(data.memories || []);
        setMemoryCount(data.total || 0);
        setMemoryTidyDue(Boolean(data.tidyDue));
        setMemoryLastReviewedAt(data.lastReviewedAt || null);
        setNotionToken(savedNotionToken);
        if (savedSupabase) {
          try {
            const saved = JSON.parse(savedSupabase) as { url?: string; key?: string };
            setSupabaseUrl(saved.url || "");
            setSupabaseKey(saved.key || "");
            setSupabaseUrlDraft(saved.url || "");
          } catch {
            window.localStorage.removeItem(SUPABASE_MEMORY_STORAGE);
          }
        }
      })
      .catch(() => {
        if (active) setNotice("The memory room could not be opened yet.");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      try {
        const saved = window.localStorage.getItem(DEVICE_KEYS_STORAGE);
        if (saved) setDeviceKeys(JSON.parse(saved) as DeviceKeys);
        setWebSearchEnabled(window.localStorage.getItem(WEB_SEARCH_STORAGE) === "enabled");
      } catch {
        window.localStorage.removeItem(DEVICE_KEYS_STORAGE);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const savedFunds = window.localStorage.getItem(PROVIDER_FUNDS_STORAGE);
        if (savedFunds) {
          const parsed = JSON.parse(savedFunds) as ProviderFunds;
          setProviderFunds(parsed);
          setProviderFundDrafts(
            Object.fromEntries(
              Object.entries(parsed).map(([provider, anchor]) => [
                provider,
                String((anchor as ProviderFundAnchor).balance),
              ]),
            ) as Partial<Record<Companion["provider"], string>>,
          );
        }
        setOpenRouterManagementKey(
          window.localStorage.getItem(OPENROUTER_MANAGEMENT_KEY_STORAGE) || "",
        );
        setElevenLabsKey(window.localStorage.getItem(ELEVENLABS_KEY_STORAGE) || "");
        const savedVoiceSettings = window.localStorage.getItem(VOICE_SETTINGS_STORAGE);
        if (savedVoiceSettings) {
          const parsed = JSON.parse(savedVoiceSettings) as Partial<VoiceSettings>;
          setVoiceSettings({
            modelId: parsed.modelId || "eleven_multilingual_v2",
            voiceByCompanion: parsed.voiceByCompanion || {},
            modelByCompanion: parsed.modelByCompanion || {},
            tuningByCompanion: parsed.tuningByCompanion || {},
          });
        }
      } catch {
        window.localStorage.removeItem(PROVIDER_FUNDS_STORAGE);
        window.localStorage.removeItem(VOICE_SETTINGS_STORAGE);
      }
    });
  }, []);

  useEffect(() => {
    if (studioTab !== "budget") return;
    void Promise.resolve().then(() => refreshOpenRouterCredits());
    const timer = window.setInterval(
      () => void refreshOpenRouterCredits(),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, [refreshOpenRouterCredits, studioTab]);

  useEffect(() => {
    return () => {
      dictationStoppingRef.current = true;
      speechRecognitionRef.current?.stop();
      activeAudioRef.current?.pause();
      voiceRequestRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => {
      if (window.localStorage.getItem(VOICE_MODE_STORAGE) === "on") setVoiceMode(true);
      try {
        const saved = window.localStorage.getItem(ADMIN_KEYS_STORAGE);
        if (saved) setAdminKeys(JSON.parse(saved) as DeviceKeys);
      } catch {
        window.localStorage.removeItem(ADMIN_KEYS_STORAGE);
      }
    });
  }, []);

  // Pull real charged spend whenever the Spending tab is open.
  useEffect(() => {
    if (studioTab !== "budget") return;
    for (const provider of ["anthropic", "openai"] as Companion["provider"][]) {
      if (adminKeys[provider]) void refreshProviderSpend(provider);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioTab, adminKeys.anthropic, adminKeys.openai]);

  // Voice mode (PDF Phase 6): read each completed reply aloud as it lands,
  // one at a time, skipping anything already on screen when it was switched on.
  useEffect(() => {
    if (!voiceMode || !elevenLabsKey) return;
    if (speakingMessageId || generatingVoiceMessageId) return;
    const next = messages.find(
      (message) =>
        message.role === "assistant" &&
        message.status !== "streaming" &&
        Boolean(message.body) &&
        !message.id.startsWith("local-") &&
        !spokenMessageIdsRef.current.has(message.id),
    );
    if (!next) return;
    spokenMessageIdsRef.current.add(next.id);
    void readAloud(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceMode, messages, speakingMessageId, generatingVoiceMessageId, elevenLabsKey]);

  useEffect(() => {
    const media = window.matchMedia("(display-mode: standalone)");
    const updateStandalone = () =>
      setStandalone(media.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
    const capturePrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    updateStandalone();
    media.addEventListener("change", updateStandalone);
    window.addEventListener("beforeinstallprompt", capturePrompt);
    window.addEventListener("appinstalled", updateStandalone);
    return () => {
      media.removeEventListener("change", updateStandalone);
      window.removeEventListener("beforeinstallprompt", capturePrompt);
      window.removeEventListener("appinstalled", updateStandalone);
    };
  }, []);

  async function loadMessages(conversationId = activeConversationId) {
    const response = await fetch(
      `/api/chat?conversationId=${encodeURIComponent(conversationId)}`,
    );
    if (!response.ok) throw new Error("The conversation could not be loaded.");
    const data = (await response.json()) as { messages?: Message[] };
    setMessages(data.messages || []);
  }

  // A stored reply can still be generating server-side after this device
  // dropped its stream (app closed or backgrounded mid-reply), or in a
  // thread other than the one the local stream is feeding. While a stored
  // message is marked streaming and not owned by the live local stream,
  // poll until the server finishes it; also refresh when the app returns
  // to the foreground so a reply finished while away appears immediately.
  const hasDetachedStreamingReply = messages.some(
    (message) =>
      message.status === "streaming" &&
      !message.id.startsWith("local-") &&
      !liveStreamIdsRef.current.has(message.id),
  );
  useEffect(() => {
    if (!hasDetachedStreamingReply || !activeConversationId) return;
    const timer = window.setInterval(() => {
      void loadMessages(activeConversationId).catch(() => undefined);
    }, 2_500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDetachedStreamingReply, activeConversationId]);
  useEffect(() => {
    const refreshOnReturn = () => {
      if (document.visibilityState !== "visible") return;
      if (sending || !activeConversationId) return;
      void loadMessages(activeConversationId).catch(() => undefined);
    };
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () =>
      document.removeEventListener("visibilitychange", refreshOnReturn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending, activeConversationId]);

  async function refreshConversations() {
    const response = await fetch("/api/conversations");
    if (!response.ok) throw new Error("Conversation history could not be loaded.");
    const data = (await response.json()) as {
      conversations?: Conversation[];
      folders?: ChatFolder[];
    };
    setConversations(data.conversations || []);
    if (data.folders) setFolders(data.folders);
  }

  function applyConversationUpdate(updated: Conversation) {
    setConversations((current) =>
      current.map((item) => (item.id === updated.id ? updated : item)),
    );
  }

  async function patchConversation(body: Record<string, unknown>) {
    const response = await fetch("/api/conversations", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as {
      conversation?: Conversation;
      error?: string;
    };
    if (!response.ok || !data.conversation) {
      throw new Error(data.error || "The chat could not be updated.");
    }
    applyConversationUpdate(data.conversation);
    return data.conversation;
  }

  async function setConversationPinned(conversation: Conversation) {
    setMenuConversationId(null);
    try {
      await patchConversation({
        id: conversation.id,
        action: "pin",
        pinned: !conversation.pinnedAt,
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The pin could not be updated.");
    }
  }

  async function moveConversationToFolder(
    conversation: Conversation,
    folderId: string | null,
  ) {
    setMenuConversationId(null);
    setMovePickerConversationId(null);
    try {
      const updated = await patchConversation({
        id: conversation.id,
        action: "move",
        folderId,
      });
      const folderName = folders.find((folder) => folder.id === folderId)?.name;
      setNotice(
        folderId && folderName
          ? `${updated.title} moved to ${folderName}.`
          : `${updated.title} returned to its companion group.`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The chat could not be moved.");
    }
  }

  async function createFolderAndMove(conversation: Conversation) {
    const name = newFolderDraft.trim();
    if (!name) return;
    try {
      const response = await fetch("/api/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = (await response.json()) as { folder?: ChatFolder; error?: string };
      if (!response.ok || !data.folder) {
        throw new Error(data.error || "The folder could not be created.");
      }
      setFolders((current) =>
        current.some((folder) => folder.id === data.folder?.id)
          ? current
          : [...current, data.folder as ChatFolder],
      );
      setNewFolderDraft("");
      await moveConversationToFolder(conversation, data.folder.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The folder could not be created.");
    }
  }

  async function deleteFolder(folder: ChatFolder) {
    try {
      const response = await fetch(`/api/folders?id=${encodeURIComponent(folder.id)}`, {
        method: "DELETE",
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "The folder could not be removed.");
      setFolders((current) => current.filter((item) => item.id !== folder.id));
      setConversations((current) =>
        current.map((item) =>
          item.folderId === folder.id ? { ...item, folderId: null } : item,
        ),
      );
      setNotice(`${folder.name} removed — its chats went back to their companion groups.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The folder could not be removed.");
    }
  }

  async function setConversationModel(value: string) {
    if (!activeConversation || sending || !activeEngineCompanionId) return;
    let selection:
      | {
          provider: Companion["provider"];
          model: string;
        }
      | undefined;
    if (value !== "default") {
      try {
        selection = JSON.parse(value) as {
          provider: Companion["provider"];
          model: string;
        };
      } catch {
        setNotice("That model selection could not be read.");
        return;
      }
    }
    try {
      const response = await fetch("/api/conversations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: activeConversation.id,
          action: "model",
          companionId: activeEngineCompanionId,
          ...(selection
            ? {
                provider: selection.provider,
                model: selection.model,
              }
            : { useDefault: true }),
        }),
      });
      const data = (await response.json()) as {
        conversation?: Conversation;
        error?: string;
      };
      if (!response.ok || !data.conversation) {
        throw new Error(data.error || "The chat model could not be changed.");
      }
      setConversations((current) =>
        current.map((item) =>
          item.id === data.conversation?.id
            ? (data.conversation as Conversation)
            : item,
        ),
      );
      const updatedMember = data.conversation.members.find(
        (member) => member.id === activeEngineCompanionId,
      );
      if (updatedMember && !providerConnected(updatedMember.provider)) {
        setNotice(
          `${providerInfo[updatedMember.provider].name} is selected for ${activeEngineCompanion.name} in this chat. Connect its API key before sending.`,
        );
      } else {
        setNotice(
          selection
            ? `${activeEngineCompanion.name} will use ${updatedMember?.model || selection.model} in this chat.`
            : `${activeEngineCompanion.name} is following the companion default again in this chat.`,
        );
      }
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "The chat model could not be changed.",
      );
    }
  }

  async function selectConversation(conversationId: string) {
    if (pendingAttachments.length && conversationId !== activeConversationId) {
      setNotice("Send or remove the pending attachments before changing rooms.");
      setSidebarOpen(false);
      return;
    }
    if (conversationId === activeConversationId) {
      setSidebarOpen(false);
      return;
    }
    setLoadingConversation(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/chat?conversationId=${encodeURIComponent(conversationId)}`,
      );
      const data = (await response.json()) as { messages?: Message[]; error?: string };
      if (!response.ok) {
        throw new Error(data.error || "The conversation could not be loaded.");
      }
      setActiveConversationId(conversationId);
      setMessages(data.messages || []);
      setGroupTurn(null);
      const selectedConversation = conversations.find((item) => item.id === conversationId);
      const selectedCompanion =
        companions.find(
          (item) =>
            item.id ===
            (selectedConversation?.kind === "group"
              ? selectedConversation.members[0]?.id
              : selectedConversation?.companionId),
        ) || companion;
      setCompanion(selectedCompanion);
      setEditing(selectedCompanion);
      setGroupSpeakerId(selectedCompanion.id);
      setSidebarOpen(false);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "The conversation could not be loaded.",
      );
    } finally {
      setLoadingConversation(false);
    }
  }

  async function createConversation() {
    if (creatingConversation) return;
    if (pendingAttachments.length) {
      setNotice("Send or remove the pending attachments before opening another room.");
      return;
    }
    const kind = chatCreator || "solo";
    const companionIds =
      kind === "group"
        ? newChatCompanionIds
        : [newChatCompanionIds[0] || companion.id];
    setCreatingConversation(true);
    setNotice(null);
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, companionIds, title: newChatTitle }),
      });
      const data = (await response.json()) as {
        conversation?: Conversation;
        error?: string;
      };
      if (!response.ok || !data.conversation) {
        throw new Error(data.error || "A clean chat could not be created.");
      }
      setConversations((current) => [
        data.conversation as Conversation,
        ...current.filter((item) => item.id !== data.conversation?.id),
      ]);
      setActiveConversationId(data.conversation.id);
      const firstCompanion =
        companions.find((item) => item.id === data.conversation?.members[0]?.id) ||
        companion;
      setCompanion(firstCompanion);
      setEditing(firstCompanion);
      setGroupSpeakerId(firstCompanion.id);
      setGroupTurn(null);
      setMessages([]);
      setDraft("");
      setConversationSearch("");
      setSidebarOpen(false);
      setChatCreator(null);
      setNewChatTitle("");
      setNotice(
        kind === "group"
          ? "Group room created. Mention one or more companions, or use @everyone."
          : `Clean thread created for ${firstCompanion.name}.`,
      );
      requestAnimationFrame(() => composerTextareaRef.current?.focus());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "A clean chat could not be created.");
    } finally {
      setCreatingConversation(false);
    }
  }

  function providerConnected(provider: Companion["provider"]) {
    return Boolean(secrets[provider] || deviceKeys[provider]);
  }

  function persistDeviceKeys(next: DeviceKeys) {
    window.localStorage.setItem(DEVICE_KEYS_STORAGE, JSON.stringify(next));
    setDeviceKeys(next);
  }

  async function refreshProviderModels(
    provider: Companion["provider"],
    explicitKey?: string,
  ) {
    setLoadingModels(true);
    try {
      const key = explicitKey || deviceKeys[provider] || "";
      const response = await fetch(`/api/models?provider=${provider}`, {
        headers: key ? { "x-companion-provider-key": key } : undefined,
      });
      const data = (await response.json()) as {
        models?: ModelOption[];
        error?: string;
      };
      if (!response.ok || !data.models) {
        throw new Error(data.error || "The provider’s model list could not be loaded.");
      }
      const models = data.models;
      setModelCatalogs((current) => ({
        ...current,
        [provider]: models.length ? models : providerModels[provider],
      }));
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "The provider’s model list could not be loaded.",
      );
    } finally {
      setLoadingModels(false);
    }
  }

  async function saveDeviceKey() {
    const provider = editing.provider;
    const key = keyDraft.trim();
    if (key.length < 20) {
      setNotice("That key looks incomplete. Paste the full provider key.");
      return;
    }
    persistDeviceKeys({ ...deviceKeys, [provider]: key });
    setKeyDraft("");
    setShowKey(false);
    setNotice(`${providerInfo[provider].name} connected on this device.`);
    await refreshProviderModels(provider, key);
  }

  function removeDeviceKey(provider: Companion["provider"]) {
    const next = { ...deviceKeys };
    delete next[provider];
    persistDeviceKeys(next);
    setKeyDraft("");
    setNotice(`${providerInfo[provider].name} key removed from this device.`);
  }

  function lifetimeProviderCost(provider: Companion["provider"]) {
    return usage.lifetimeByProvider.find((item) => item.provider === provider)?.cost || 0;
  }

  // Spend since the balance was anchored. Uses the provider's own charged
  // figure when an admin key is connected, and this app's estimate otherwise.
  function spentSinceAnchor(provider: Companion["provider"]) {
    const anchor = providerFunds[provider];
    if (!anchor) return { amount: 0, reported: false };
    const reported = providerSpend[provider];
    if (reported && Date.parse(reported.since) <= Date.parse(anchor.savedAt)) {
      return { amount: Math.max(0, reported.spend), reported: true };
    }
    return {
      amount: Math.max(0, lifetimeProviderCost(provider) - anchor.trackedCost),
      reported: false,
    };
  }

  function providerBalance(provider: Companion["provider"]) {
    const anchor = providerFunds[provider];
    if (!anchor) return null;
    return Math.max(0, anchor.balance - spentSinceAnchor(provider).amount);
  }

  function saveAdminKey(provider: Companion["provider"]) {
    const key = (adminKeyDrafts[provider] || "").trim();
    if (key.length < 20) {
      setNotice("That admin key looks incomplete.");
      return;
    }
    const next = { ...adminKeys, [provider]: key };
    window.localStorage.setItem(ADMIN_KEYS_STORAGE, JSON.stringify(next));
    setAdminKeys(next);
    setAdminKeyDrafts({ ...adminKeyDrafts, [provider]: "" });
    void refreshProviderSpend(provider, next);
  }

  function removeAdminKey(provider: Companion["provider"]) {
    const next = { ...adminKeys };
    delete next[provider];
    window.localStorage.setItem(ADMIN_KEYS_STORAGE, JSON.stringify(next));
    setAdminKeys(next);
    setProviderSpend((current) => {
      const updated = { ...current };
      delete updated[provider];
      return updated;
    });
  }

  async function refreshProviderSpend(
    provider: Companion["provider"],
    keys: DeviceKeys = adminKeys,
  ) {
    const adminKey = keys[provider];
    if (!adminKey) return;
    const anchor = providerFunds[provider];
    const since = anchor?.savedAt;
    try {
      const response = await fetch(
        `/api/provider-credits?provider=${provider}${since ? `&since=${encodeURIComponent(since)}` : ""}`,
        { headers: { "x-companion-admin-key": adminKey } },
      );
      const data = (await response.json()) as {
        spend?: number;
        since?: string;
        error?: string;
      };
      if (!response.ok || typeof data.spend !== "number") {
        throw new Error(data.error || "The provider spend report could not be read.");
      }
      setProviderSpend((current) => ({
        ...current,
        [provider]: { spend: data.spend as number, since: data.since || since || "" },
      }));
      setProviderSpendErrors((current) => {
        const next = { ...current };
        delete next[provider];
        return next;
      });
    } catch (error) {
      setProviderSpendErrors((current) => ({
        ...current,
        [provider]:
          error instanceof Error ? error.message : "Spend report unavailable.",
      }));
    }
  }

  function saveProviderFund(provider: Companion["provider"]) {
    const balance = Number(providerFundDrafts[provider]);
    if (!Number.isFinite(balance) || balance < 0 || balance > 100_000) {
      setNotice("Enter the provider’s current balance between $0 and $100,000.");
      return;
    }
    const next: ProviderFunds = {
      ...providerFunds,
      [provider]: {
        balance,
        trackedCost: lifetimeProviderCost(provider),
        savedAt: new Date().toISOString(),
      },
    };
    window.localStorage.setItem(PROVIDER_FUNDS_STORAGE, JSON.stringify(next));
    setProviderFunds(next);
    setNotice(`${providerInfo[provider].name} account balance anchored at $${balance.toFixed(2)}.`);
  }

  function saveOpenRouterManagementKey() {
    const key = openRouterManagementKeyDraft.trim();
    if (key.length < 20) {
      setNotice("That OpenRouter management key looks incomplete.");
      return;
    }
    window.localStorage.setItem(OPENROUTER_MANAGEMENT_KEY_STORAGE, key);
    setOpenRouterManagementKey(key);
    setOpenRouterManagementKeyDraft("");
    setShowOpenRouterManagementKey(false);
    setNotice("OpenRouter live account-credit sync connected on this device.");
  }

  function removeOpenRouterManagementKey() {
    window.localStorage.removeItem(OPENROUTER_MANAGEMENT_KEY_STORAGE);
    setOpenRouterManagementKey("");
    setOpenRouterManagementKeyDraft("");
    setOpenRouterCredits((current) =>
      current ? { ...current, account: null, accountError: null } : null,
    );
    setNotice("OpenRouter management key removed from this device.");
  }

  function persistVoiceSettings(next: VoiceSettings) {
    window.localStorage.setItem(VOICE_SETTINGS_STORAGE, JSON.stringify(next));
    setVoiceSettings(next);
  }

  function companionVoiceModel(companionId: string) {
    return (
      voiceSettings.modelByCompanion[companionId] ||
      voiceSettings.modelId ||
      "eleven_multilingual_v2"
    );
  }

  function companionVoiceTuning(companionId: string): VoiceTuning {
    return {
      ...DEFAULT_VOICE_TUNING,
      ...(voiceSettings.tuningByCompanion[companionId] || {}),
    };
  }

  function updateCompanionVoiceTuning(
    companionId: string,
    patch: Partial<VoiceTuning>,
  ) {
    persistVoiceSettings({
      ...voiceSettings,
      tuningByCompanion: {
        ...voiceSettings.tuningByCompanion,
        [companionId]: {
          ...companionVoiceTuning(companionId),
          ...patch,
        },
      },
    });
  }

  async function refreshElevenLabs(explicitKey?: string) {
    const key = explicitKey || elevenLabsKey;
    if (!key) {
      setNotice("Connect an ElevenLabs API key first.");
      return;
    }
    setLoadingVoice(true);
    try {
      const headers = { "x-companion-elevenlabs-key": key };
      const [voicesResponse, subscriptionResponse] = await Promise.all([
        fetch("/api/voice?action=voices", { headers }),
        fetch("/api/voice?action=subscription", { headers }),
      ]);
      const voicesData = (await voicesResponse.json()) as {
        voices?: ElevenVoice[];
        error?: string;
      };
      const subscriptionData = (await subscriptionResponse.json()) as {
        subscription?: ElevenSubscription;
        error?: string;
      };
      if (!voicesResponse.ok || !voicesData.voices) {
        throw new Error(voicesData.error || "ElevenLabs voices could not be loaded.");
      }
      if (!subscriptionResponse.ok || !subscriptionData.subscription) {
        throw new Error(
          subscriptionData.error || "ElevenLabs usage could not be loaded.",
        );
      }
      setElevenVoices(voicesData.voices);
      setElevenSubscription(subscriptionData.subscription);
      if (!voiceSettings.voiceByCompanion[editing.id] && voicesData.voices[0]) {
        persistVoiceSettings({
          ...voiceSettings,
          voiceByCompanion: {
            ...voiceSettings.voiceByCompanion,
            [editing.id]: voicesData.voices[0].id,
          },
        });
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "ElevenLabs could not be reached.");
    } finally {
      setLoadingVoice(false);
    }
  }

  async function saveElevenLabsKey() {
    const key = elevenLabsKeyDraft.trim();
    if (key.length < 20) {
      setNotice("That ElevenLabs key looks incomplete.");
      return;
    }
    window.localStorage.setItem(ELEVENLABS_KEY_STORAGE, key);
    setElevenLabsKey(key);
    setElevenLabsKeyDraft("");
    setShowElevenLabsKey(false);
    await refreshElevenLabs(key);
    setNotice("ElevenLabs connected on this device.");
  }

  function removeElevenLabsKey() {
    window.localStorage.removeItem(ELEVENLABS_KEY_STORAGE);
    setElevenLabsKey("");
    setElevenLabsKeyDraft("");
    setElevenVoices([]);
    setElevenSubscription(null);
    setNotice("ElevenLabs key removed from this device.");
  }

  function readableMessage(body: string) {
    return body
      .replace(/```[\s\S]*?```/g, " Code block omitted. ")
      .replace(/<message_time\b[^>]*\/?>/gi, " ")
      .replace(/<\/?context_turn\b[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~`>#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Drag-and-drop anywhere on the app (PDF Phase 7). Depth counting keeps
  // the overlay stable while the pointer crosses child elements.
  function handleDragEnter(event: React.DragEvent) {
    if (!Array.from(event.dataTransfer.types || []).includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  }

  function handleDragOver(event: React.DragEvent) {
    if (!Array.from(event.dataTransfer.types || []).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave() {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (!dragDepthRef.current) setDropActive(false);
  }

  function handleDrop(event: React.DragEvent) {
    if (!Array.from(event.dataTransfer.types || []).includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDropActive(false);
    if (!activeConversation) {
      setNotice("Open a chat before dropping files in.");
      return;
    }
    void attachFiles(event.dataTransfer.files);
  }

  async function copyMessage(message: Message) {
    try {
      await navigator.clipboard.writeText(message.body);
    } catch {
      // Older webviews without the async clipboard API.
      const area = document.createElement("textarea");
      area.value = message.body;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopiedMessageId(message.id);
    window.setTimeout(
      () =>
        setCopiedMessageId((current) => (current === message.id ? null : current)),
      1_600,
    );
  }

  async function readAloud(message: Message) {
    if (speakingMessageId === message.id) {
      voiceRequestRef.current?.abort();
      voiceRequestRef.current = null;
      activeAudioRef.current?.pause();
      activeAudioRef.current = null;
      setSpeakingMessageId(null);
      setGeneratingVoiceMessageId(null);
      return;
    }
    voiceRequestRef.current?.abort();
    const messageOwner = messageCompanion(message);
    const voiceId = voiceSettings.voiceByCompanion[messageOwner.id];
    if (!elevenLabsKey || !voiceId) {
      setNotice(`Choose an ElevenLabs voice for ${messageOwner.name} in Voice.`);
      openStudio("voice");
      return;
    }
    activeAudioRef.current?.pause();
    setSpeakingMessageId(message.id);
    setGeneratingVoiceMessageId(message.id);
    try {
      const controller = new AbortController();
      voiceRequestRef.current = controller;
      const speech = readableMessage(message.body);
      if (!speech) throw new Error("That reply has no readable text.");
      const tuning = companionVoiceTuning(messageOwner.id);
      const response = await fetch("/api/voice", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-companion-elevenlabs-key": elevenLabsKey,
        },
        body: JSON.stringify({
          text: speech,
          voiceId,
          modelId: companionVoiceModel(messageOwner.id),
          stability: tuning.stability,
          similarityBoost: tuning.similarityBoost,
          style: tuning.style,
          speakerBoost: tuning.speakerBoost,
          speed: tuning.speed,
          overrideVoiceSettings: Boolean(
            voiceSettings.tuningByCompanion[messageOwner.id],
          ),
        }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "ElevenLabs could not read that reply.");
      }
      const contentType = response.headers.get("content-type") || "";
      const audioBytes = await response.arrayBuffer();
      if (!contentType.toLowerCase().startsWith("audio/") || audioBytes.byteLength < 512) {
        throw new Error("ElevenLabs returned an invalid or incomplete audio clip.");
      }
      const objectUrl = URL.createObjectURL(
        new Blob([audioBytes], { type: contentType }),
      );
      const audio = new Audio(objectUrl);
      audio.preload = "auto";
      activeAudioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(objectUrl);
        activeAudioRef.current = null;
        setSpeakingMessageId(null);
        setGeneratingVoiceMessageId(null);
        void refreshElevenLabs();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        activeAudioRef.current = null;
        setSpeakingMessageId(null);
        setGeneratingVoiceMessageId(null);
        setNotice("The generated audio could not be played.");
      };
      await audio.play();
      voiceRequestRef.current = null;
      setGeneratingVoiceMessageId(null);
    } catch (error) {
      voiceRequestRef.current = null;
      setSpeakingMessageId(null);
      setGeneratingVoiceMessageId(null);
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setNotice(error instanceof Error ? error.message : "Read aloud failed.");
      }
    }
  }

  function toggleDictation() {
    if (listening) {
      dictationStoppingRef.current = true;
      speechRecognitionRef.current?.stop();
      return;
    }
    const scopedWindow = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const Constructor =
      scopedWindow.SpeechRecognition || scopedWindow.webkitSpeechRecognition;
    if (!Constructor) {
      setNotice("Talk-to-text is unavailable in this browser. Chrome on Android supports it.");
      return;
    }
    const startingDraft = draft.trimEnd();
    // Browsers end a recognition session on every natural pause, which used to
    // end dictation mid-thought. Text finalized in earlier sessions is kept
    // here and the session restarts until dictation is stopped deliberately.
    let committed = "";
    let emptyRestarts = 0;
    dictationStoppingRef.current = false;

    const joinDraft = (...parts: string[]) =>
      [startingDraft, committed, ...parts].filter(Boolean).join(" ").trimStart();

    const startSession = () => {
      const recognition = new Constructor();
      const finalSegments = new Map<number, string>();
      const startedAt = Date.now();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      const sessionText = () =>
        Array.from(finalSegments.entries())
          .sort(([left], [right]) => left - right)
          .map(([, segment]) => segment)
          .join(" ");

      recognition.onresult = (event) => {
        let interim = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const segment = result[0]?.transcript?.trim();
          if (!segment) continue;
          if (result.isFinal) finalSegments.set(index, segment);
          else interim = segment;
        }
        setDraft(joinDraft(sessionText(), interim));
      };

      recognition.onerror = (event) => {
        // A silent stretch is normal mid-sentence; keep listening through it.
        if (event.error === "no-speech" || event.error === "aborted") return;
        dictationStoppingRef.current = true;
        setNotice(`Talk-to-text stopped: ${event.error}.`);
      };

      recognition.onend = () => {
        const captured = sessionText();
        committed = [committed, captured].filter(Boolean).join(" ");
        emptyRestarts =
          captured || Date.now() - startedAt > 900 ? 0 : emptyRestarts + 1;
        // Restart unless it was stopped on purpose or the microphone is
        // failing to open at all (guards against a restart loop).
        if (!dictationStoppingRef.current && emptyRestarts < 4) {
          startSession();
          return;
        }
        speechRecognitionRef.current = null;
        setDraft(joinDraft());
        setListening(false);
        requestAnimationFrame(() => composerTextareaRef.current?.focus());
      };

      speechRecognitionRef.current = recognition;
      recognition.start();
    };

    setListening(true);
    startSession();
  }

  async function installApp() {
    if (standalone) {
      setNotice("Companion Lab is already running as an installed app.");
      return;
    }
    if (!installPrompt) {
      setNotice(
        "Chrome is still preparing the install prompt. Keep Companion Lab open for about 30 seconds, tap anywhere once, then try this button again. Chrome’s menu → “Add to Home screen” also works.",
      );
      return;
    }
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") {
      setStandalone(true);
      setNotice("Companion Lab installed. The browser cage has been removed.");
    }
    setInstallPrompt(null);
  }

  function openStudio(tab: StudioTab) {
    setEditing(companion);
    setEditingProfile(userProfile);
    setStudioTab(tab);
    setSidebarOpen(false);
    setNotice(null);
    if (tab === "provider") {
      setKeyDraft("");
      setShowKey(false);
      void refreshProviderModels(companion.provider);
    }
    if (tab === "memory") {
      setNotionTokenDraft("");
      setShowNotionToken(false);
      setNotionDestination("companion");
      void searchMemories("", memoryShelf, false, memoryCompanionId);
      void loadMemoryImports(memoryCompanionId);
    }
    if (tab === "budget") {
      setEditingMonthlyBudget(usage.monthlyBudget);
      void refreshUsage();
      void refreshOpenRouterCredits();
    }
    if (tab === "voice") {
      setElevenLabsKeyDraft("");
      setShowElevenLabsKey(false);
      if (elevenLabsKey) void refreshElevenLabs();
    }
  }

  function openChatCreator(kind: "solo" | "group", preferredCompanionId = companion.id) {
    setChatCreator(kind);
    setNewChatTitle("");
    setNewChatCompanionIds(
      kind === "group"
        ? Array.from(
            new Set([preferredCompanionId, ...companions.slice(0, 2).map((item) => item.id)]),
          )
        : [preferredCompanionId],
    );
    setSidebarOpen(false);
    setNotice(null);
  }

  function editCompanionProfile(selected: Companion) {
    setCreatingCompanion(false);
    setEditing(selected);
    setStudioTab("identity");
  }

  function beginNewCompanion() {
    setCreatingCompanion(true);
    setEditing(newCompanionDraft());
    setStudioTab("identity");
  }

  async function loadIdentityFile(file: File) {
    if (file.size > 2_000_000) {
      setNotice("Identity uploads must be smaller than 2 MB.");
      return;
    }
    try {
      let content = "";
      let displayName = file.name;
      if (file.name.toLocaleLowerCase().endsWith(".zip")) {
        const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
        const entries = Object.entries(archive)
          .filter(([name]) => !name.endsWith("/") && /\.(md|txt)$/i.test(name))
          .sort(([left], [right]) => {
            const leftIsSkill = /(^|\/)skill\.md$/i.test(left);
            const rightIsSkill = /(^|\/)skill\.md$/i.test(right);
            if (leftIsSkill !== rightIsSkill) return leftIsSkill ? -1 : 1;
            return left.localeCompare(right);
          });
        if (!entries.length) {
          throw new Error("That ZIP does not contain a Markdown or text identity file.");
        }
        content = entries
          .map(
            ([name, bytes]) =>
              `\n\n--- Identity bundle file: ${name} ---\n\n${strFromU8(bytes).trim()}`,
          )
          .join("")
          .trim();
        displayName =
          entries.length === 1
            ? `${file.name} · ${entries[0][0].split("/").pop()}`
            : `${file.name} · ${entries.length} identity files`;
      } else {
        content = await file.text();
      }
      if (content.length > 200_000) {
        throw new Error("The extracted identity must be smaller than 200,000 characters.");
      }
      setEditing((current) => ({
        ...current,
        identitySource: "file",
        identityFileName: displayName,
        identityFileContent: content,
      }));
      setNotice(`${displayName} loaded. Save changes to make it active.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The identity file could not be read.");
    }
  }

  async function saveCompanion() {
    const wasCreating = creatingCompanion;
    setSaving(true);
    try {
      const response = await fetch("/api/companion", {
        method: wasCreating ? "POST" : "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editing),
      });
      const data = (await response.json()) as {
        companion?: Companion;
        secrets?: ProviderSecrets;
        error?: string;
      };
      if (!response.ok || !data.companion) {
        throw new Error(data.error || "The companion’s settings could not be saved.");
      }
      if (!wasCreating && companion.id === data.companion.id) {
        setCompanion(data.companion);
      }
      setEditing(data.companion);
      setCompanions((current) => {
        const exists = current.some((item) => item.id === data.companion?.id);
        return exists
          ? current.map((item) => (item.id === data.companion?.id ? data.companion as Companion : item))
          : [...current, data.companion as Companion].sort((a, b) =>
              a.name.localeCompare(b.name),
            );
      });
      setCreatingCompanion(false);
      if (data.secrets) setSecrets(data.secrets);
      setNotice(
        wasCreating
          ? `${data.companion.name} added to the companion roster. Your open chat stayed exactly where it was.`
          : `${data.companion.name} saved · identity version ${data.companion.version}`,
      );
      setStudioTab(wasCreating ? "companions" : null);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "The companion’s settings could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function renameConversation() {
    const title = renameDraft.trim();
    if (!renamingConversationId || !title) return;
    try {
      const response = await fetch("/api/conversations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: renamingConversationId, title }),
      });
      const data = (await response.json()) as {
        conversation?: Conversation;
        error?: string;
      };
      if (!response.ok || !data.conversation) {
        throw new Error(data.error || "The chat name could not be saved.");
      }
      setConversations((current) =>
        current.map((item) =>
          item.id === data.conversation?.id ? (data.conversation as Conversation) : item,
        ),
      );
      setRenamingConversationId(null);
      setRenameDraft("");
      setNotice(`Chat renamed to ${data.conversation.title}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The chat name could not be saved.");
    }
  }

  async function setConversationArchived(conversation: Conversation) {
    if (sending) {
      setNotice("Let the current reply finish before moving this room.");
      return;
    }
    if (
      conversation.id === activeConversationId &&
      pendingAttachments.length
    ) {
      setNotice("Send or remove the pending attachments before archiving this room.");
      return;
    }
    const restoring = Boolean(conversation.archivedAt);
    if (!restoring) {
      setPendingConversationAction({ action: "archive", conversation });
      return;
    }
    await updateConversationArchived(conversation);
  }

  async function updateConversationArchived(conversation: Conversation) {
    const restoring = Boolean(conversation.archivedAt);
    setRunningConversationAction(true);
    try {
      const response = await fetch("/api/conversations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: conversation.id,
          action: restoring ? "restore" : "archive",
        }),
      });
      const data = (await response.json()) as {
        conversation?: Conversation;
        error?: string;
      };
      if (!response.ok || !data.conversation) {
        throw new Error(data.error || "The chat archive could not be updated.");
      }
      setConversations((current) =>
        current.map((item) =>
          item.id === data.conversation?.id ? (data.conversation as Conversation) : item,
        ),
      );
      if (!restoring && conversation.id === activeConversationId) {
        const next = conversations.find(
          (item) => item.id !== conversation.id && !item.archivedAt,
        );
        if (next) {
          await selectConversation(next.id);
        } else {
          setMessages([]);
          setActiveConversationId("");
          openChatCreator("solo", conversation.companionId);
        }
      }
      setNotice(
        restoring
          ? `${conversation.title} restored.`
          : `${conversation.title} moved to Archived.`,
      );
      setPendingConversationAction(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The chat archive could not be updated.");
    } finally {
      setRunningConversationAction(false);
    }
  }

  async function deleteConversation(conversation: Conversation) {
    if (sending) {
      setNotice("Let the current reply finish before deleting a room.");
      return;
    }
    setPendingConversationAction({ action: "delete", conversation });
  }

  async function permanentlyDeleteConversation(conversation: Conversation) {
    setRunningConversationAction(true);
    try {
      const response = await fetch(
        `/api/conversations?id=${encodeURIComponent(conversation.id)}`,
        { method: "DELETE" },
      );
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "The chat could not be deleted.");
      }
      const next = conversations.find(
        (item) => item.id !== conversation.id && !item.archivedAt,
      );
      setConversations((current) =>
        current.filter((item) => item.id !== conversation.id),
      );
      if (conversation.id === activeConversationId) {
        setPendingAttachments([]);
        if (next) {
          await selectConversation(next.id);
        } else {
          setMessages([]);
          setActiveConversationId("");
          openChatCreator("solo", conversation.companionId);
        }
      }
      setNotice(`${conversation.title} permanently deleted.`);
      setPendingConversationAction(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The chat could not be deleted.");
    } finally {
      setRunningConversationAction(false);
    }
  }

  async function refreshUsage() {
    try {
      const response = await fetch("/api/usage");
      const data = (await response.json()) as { usage?: UsageSummary; error?: string };
      if (!response.ok || !data.usage) {
        throw new Error(data.error || "Usage could not be loaded.");
      }
      setUsage(data.usage);
      setEditingMonthlyBudget(data.usage.monthlyBudget);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Usage could not be loaded.");
    }
  }

  async function saveUsageBudget() {
    setSaving(true);
    try {
      const response = await fetch("/api/usage", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ monthlyBudget: editingMonthlyBudget }),
      });
      const data = (await response.json()) as { usage?: UsageSummary; error?: string };
      if (!response.ok || !data.usage) {
        throw new Error(data.error || "The monthly budget could not be saved.");
      }
      setUsage(data.usage);
      setNotice(`Monthly API budget set to $${data.usage.monthlyBudget.toFixed(2)}.`);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "The monthly budget could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  function saveNotionToken() {
    const token = notionTokenDraft.trim();
    if (token.length < 20) {
      setNotice("That Notion token looks incomplete.");
      return;
    }
    window.localStorage.setItem(NOTION_KEY_STORAGE, token);
    setNotionToken(token);
    setNotionTokenDraft("");
    setShowNotionToken(false);
    setNotice("Notion connected on this device. Save the source, then sync it.");
  }

  function removeNotionToken() {
    window.localStorage.removeItem(NOTION_KEY_STORAGE);
    setNotionToken("");
    setNotionTokenDraft("");
    setNotice("Notion token removed from this device.");
  }

  async function saveSupabaseMemoryConnection() {
    const url = supabaseUrlDraft.trim().replace(/\/+$/, "");
    const key = supabaseKeyDraft.trim() || supabaseKey;
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) || key.length < 40) {
      setNotice("Enter the full Supabase project URL and a Secret or Legacy service_role key.");
      return;
    }
    setCheckingSupabase(true);
    try {
      const headers = {
        "x-companion-supabase-url": url,
        "x-companion-supabase-key": key,
      };
      const check = await fetch("/api/supabase-memory", { headers });
      const checkData = (await check.json()) as { error?: string };
      if (!check.ok) throw new Error(checkData.error || "Supabase memory could not connect.");
      const migration = await fetch("/api/supabase-memory", { method: "POST", headers });
      const migrated = (await migration.json()) as { migrated?: number; error?: string };
      if (!migration.ok) throw new Error(migrated.error || "Existing memory could not be migrated.");
      window.localStorage.setItem(SUPABASE_MEMORY_STORAGE, JSON.stringify({ url, key }));
      setSupabaseUrl(url);
      setSupabaseKey(key);
      setSupabaseKeyDraft("");
      setShowSupabaseKey(false);
      setNotice(`Supabase memory connected · ${migrated.migrated || 0} existing memories migrated.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Supabase memory could not connect.");
    } finally {
      setCheckingSupabase(false);
    }
  }

  function removeSupabaseMemoryConnection() {
    window.localStorage.removeItem(SUPABASE_MEMORY_STORAGE);
    setSupabaseUrl("");
    setSupabaseKey("");
    setSupabaseKeyDraft("");
    setNotice("Supabase memory disconnected on this device.");
  }

  async function copySupabaseSetupSql() {
    try {
      const response = await fetch("/supabase-memory-setup.sql", { cache: "no-store" });
      if (!response.ok) throw new Error("The setup SQL could not be loaded.");
      const sql = await response.text();
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(sql);
      } else {
        const field = document.createElement("textarea");
        field.value = sql;
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand("copy");
        field.remove();
        if (!copied) throw new Error("Your browser blocked copying the setup SQL.");
      }
      setNotice("Supabase setup SQL copied. Paste it into a new Supabase SQL Editor query and press Run.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The setup SQL could not be copied.");
    }
  }

  async function saveMemorySettings(close = true) {
    setSaving(true);
    try {
      const response = await fetch("/api/memory", {
        method: "PUT",
        headers: { "content-type": "application/json", ...supabaseHeaders() },
        body: JSON.stringify(editingProfile),
      });
      const data = (await response.json()) as { profile?: UserProfile; error?: string };
      if (!response.ok || !data.profile) {
        throw new Error(data.error || "Your profile could not be saved.");
      }
      setUserProfile(data.profile);
      setEditingProfile(data.profile);
      setNotice("Your profile and memory source are saved.");
      if (close) setStudioTab(null);
      return data.profile;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Memory settings could not be saved.");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function searchMemories(
    query = memoryQuery,
    shelf: "shared" | "companion" = memoryShelf,
    append = false,
    companionId = memoryCompanionId,
  ) {
    setLoadingMemory(true);
    try {
      const response = await fetch(
        `/api/memory?q=${encodeURIComponent(query.trim())}&companionId=${encodeURIComponent(companionId)}&shelf=${shelf}&category=${encodeURIComponent(memoryCategory)}&source=${encodeURIComponent(memorySource)}&offset=${append ? memoryResults.length : 0}&limit=100`,
        { headers: supabaseHeaders() },
      );
      const data = (await response.json()) as {
        profile?: UserProfile;
        memories?: Memory[];
        total?: number;
        shelfTotal?: number;
        hasMore?: boolean;
        tidyDue?: boolean;
        lastReviewedAt?: string | null;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "Memory search failed.");
      setMemoryResults((current) =>
        append ? [...current, ...(data.memories || [])] : (data.memories || []),
      );
      setMemoryCount(data.total || 0);
      setMemoryShelfCount(data.shelfTotal || 0);
      setMemoryHasMore(Boolean(data.hasMore));
      setMemoryTidyDue(Boolean(data.tidyDue));
      setMemoryLastReviewedAt(data.lastReviewedAt || null);
      if (!append) setSelectedMemoryIds([]);
      if (data.profile) {
        setUserProfile(data.profile);
        setEditingProfile(data.profile);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Memory search failed.");
    } finally {
      setLoadingMemory(false);
    }
  }

  async function loadMemoryImports(companionId = memoryCompanionId) {
    try {
      const response = await fetch(
        `/api/memory/import?companionId=${encodeURIComponent(companionId)}`,
      );
      const data = (await response.json()) as {
        imports?: MemoryImport[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "Import history could not be loaded.");
      setMemoryImports(data.imports || []);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Import history could not be loaded.");
    }
  }

  async function finishMemoryReview() {
    try {
      const response = await fetch("/api/memory", {
        method: "POST",
        headers: { "content-type": "application/json", ...supabaseHeaders() },
        body: JSON.stringify({ action: "reviewed" }),
      });
      const data = (await response.json()) as {
        tidyDue?: boolean;
        lastReviewedAt?: string | null;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "The memory review could not be finished.");
      setMemoryTidyDue(Boolean(data.tidyDue));
      setMemoryLastReviewedAt(data.lastReviewedAt || new Date().toISOString());
      setNotice("Monthly memory review finished. The next review is due in 30 days.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The memory review could not be finished.");
    }
  }

  async function exportMemoryArchive() {
    try {
      const response = await fetch("/api/memory?export=all", { headers: supabaseHeaders() });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : "Memory export failed.",
        );
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `companion-lab-memory-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice("Memory archive exported as readable JSON.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Memory export failed.");
    }
  }

  async function addMemory() {
    const content = newMemory.trim();
    if (!content) return;
    setLoadingMemory(true);
    try {
      const response = await fetch("/api/memory", {
        method: "POST",
        headers: { "content-type": "application/json", ...supabaseHeaders() },
        body: JSON.stringify({
          content,
          category: newMemoryCategory,
          companionId: memoryCompanion.id,
          ownerId: memoryShelf === "shared" ? "shared" : memoryCompanion.id,
        }),
      });
      const data = (await response.json()) as { memory?: Memory; error?: string };
      if (!response.ok || !data.memory) {
        throw new Error(data.error || "The memory could not be saved.");
      }
      setNewMemory("");
      setMemoryResults((current) => [data.memory as Memory, ...current]);
      setMemoryCount((current) => current + 1);
      setNotice(
        `${newMemoryCategory === "rule" || newMemoryCategory === "correction" ? "Pinned rule" : "Memory"} saved to ${memoryShelf === "shared" ? "Everyone" : memoryCompanion.name}.`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The memory could not be saved.");
    } finally {
      setLoadingMemory(false);
    }
  }

  async function moveMemory(memory: Memory) {
    const targetOwner = memory.ownerId === "shared" ? memoryCompanion.id : "shared";
    setLoadingMemory(true);
    try {
      const response = await fetch("/api/memory", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...supabaseHeaders() },
        body: JSON.stringify({
          id: memory.id,
          companionId: memoryCompanion.id,
          ownerId: targetOwner,
        }),
      });
      const data = (await response.json()) as { memory?: Memory; error?: string };
      if (!response.ok || !data.memory) {
        throw new Error(data.error || "The memory could not be moved.");
      }
      setMemoryResults((current) => current.filter((item) => item.id !== memory.id));
      setMemoryCount((current) => Math.max(0, current - 1));
      setNotice(
        targetOwner === "shared"
          ? "Memory moved to Everyone. Every companion can retrieve it now."
          : `Memory moved to ${memoryCompanion.name}’s private shelf.`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The memory could not be moved.");
    } finally {
      setLoadingMemory(false);
    }
  }

  async function forgetMemory(memory: Memory) {
    if (!window.confirm("Forget this memory? It will stop appearing in future chats.")) return;
    setLoadingMemory(true);
    try {
      const response = await fetch("/api/memory", {
        method: "DELETE",
        headers: { "content-type": "application/json", ...supabaseHeaders() },
        body: JSON.stringify({ id: memory.id, companionId: memoryCompanion.id }),
      });
      const data = (await response.json()) as { forgotten?: string; error?: string };
      if (!response.ok || !data.forgotten) {
        throw new Error(data.error || "The memory could not be forgotten.");
      }
      setMemoryResults((current) => current.filter((item) => item.id !== memory.id));
      setMemoryCount((current) => Math.max(0, current - 1));
      setNotice("Memory forgotten. It will no longer be loaded into chat.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The memory could not be forgotten.");
    } finally {
      setLoadingMemory(false);
    }
  }

  async function forgetSelectedMemories() {
    if (!selectedMemoryIds.length) return;
    if (!window.confirm(`Forget ${selectedMemoryIds.length} selected memories? They will stop appearing in future chats.`)) return;
    setLoadingMemory(true);
    try {
      const response = await fetch("/api/memory", {
        method: "DELETE",
        headers: { "content-type": "application/json", ...supabaseHeaders() },
        body: JSON.stringify({ ids: selectedMemoryIds, companionId: memoryCompanion.id }),
      });
      const data = (await response.json()) as {
        forgottenIds?: string[];
        forgottenCount?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "The selected memories could not be forgotten.");
      const forgotten = new Set(data.forgottenIds || []);
      setMemoryResults((current) => current.filter((item) => !forgotten.has(item.id)));
      setMemoryCount((current) => Math.max(0, current - forgotten.size));
      setMemoryShelfCount((current) => Math.max(0, current - forgotten.size));
      setSelectedMemoryIds([]);
      setNotice(`${data.forgottenCount || 0} memories forgotten. They will no longer be loaded into chat.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The selected memories could not be forgotten.");
    } finally {
      setLoadingMemory(false);
    }
  }

  function beginEditMemory(memory: Memory) {
    setEditingMemoryId(memory.id);
    setEditingMemoryContent(memory.content);
    setEditingMemoryCategory(memory.category);
  }

  async function saveMemoryEdit(memory: Memory) {
    const content = editingMemoryContent.trim();
    if (!content) return;
    setLoadingMemory(true);
    try {
      const response = await fetch("/api/memory", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...supabaseHeaders() },
        body: JSON.stringify({
          id: memory.id,
          companionId: memoryCompanion.id,
          ownerId: memory.ownerId,
          content,
          category: editingMemoryCategory,
        }),
      });
      const data = (await response.json()) as { memory?: Memory; error?: string };
      if (!response.ok || !data.memory) {
        throw new Error(data.error || "The memory could not be updated.");
      }
      setMemoryResults((current) =>
        current.map((item) => (item.id === memory.id ? (data.memory as Memory) : item)),
      );
      setEditingMemoryId(null);
      setNotice("Memory corrected. Future chats will receive the updated version.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The memory could not be updated.");
    } finally {
      setLoadingMemory(false);
    }
  }

  async function scanSemanticDuplicates(afterImport = false) {
    setScanningDuplicates(true);
    setDuplicateProposals([]);
    setSelectedDuplicateProposalIds([]);
    try {
      const response = await fetch("/api/memory/dedupe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...supabaseHeaders(),
          ...(deviceKeys[memoryCompanion.provider]
            ? { "x-companion-provider-key": deviceKeys[memoryCompanion.provider] }
            : {}),
        },
        body: JSON.stringify({ action: "scan", companionId: memoryCompanion.id }),
      });
      const data = (await response.json()) as {
        proposals?: DuplicateProposal[];
        scanned?: number;
        exactGroups?: number;
        candidatePairs?: number;
        semanticWarning?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "Semantic duplicate scan failed.");
      const proposals = data.proposals || [];
      setDuplicateProposals(proposals);
      setDuplicateScanCount(data.scanned || 0);
      const prefix = afterImport ? "Import finished. " : "";
      setNotice(
        proposals.length
          ? `${prefix}${proposals.length} duplicate ${proposals.length === 1 ? "group" : "groups"} found across ${(data.scanned || 0).toLocaleString()} active memories, including ${data.exactGroups || 0} exact ${data.exactGroups === 1 ? "match" : "matches"}. Nothing changed yet—review the proposed merges.${data.semanticWarning ? ` Exact matches are shown; semantic validation reported: ${data.semanticWarning}` : ""}`
          : `${prefix}No strict duplicate groups were found across ${(data.scanned || 0).toLocaleString()} active memories.${data.semanticWarning ? ` Semantic validation reported: ${data.semanticWarning}` : ""}`,
      );
      void refreshUsage();
      void refreshOpenRouterCredits();
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Semantic duplicate scan failed.");
      return false;
    } finally {
      setScanningDuplicates(false);
    }
  }

  function editDuplicateProposal(id: string, mergedContent: string) {
    setDuplicateProposals((current) =>
      current.map((proposal) =>
        proposal.id === id ? { ...proposal, mergedContent } : proposal,
      ),
    );
  }

  async function mergeSelectedDuplicates() {
    const selected = duplicateProposals.filter((proposal) =>
      selectedDuplicateProposalIds.includes(proposal.id),
    );
    if (!selected.length) {
      setNotice("Select at least one duplicate group to merge.");
      return;
    }
    const copies = selected.reduce(
      (total, proposal) => total + Math.max(0, proposal.memoryIds.length - 1),
      0,
    );
    if (
      !window.confirm(
        `Merge ${selected.length} reviewed ${selected.length === 1 ? "group" : "groups"} and retire ${copies} duplicate ${copies === 1 ? "copy" : "copies"}? The retained text shown here will become the active memory.`,
      )
    ) return;
    setMergingDuplicates(true);
    try {
      const response = await fetch("/api/memory/dedupe", {
        method: "POST",
        headers: { "content-type": "application/json", ...supabaseHeaders() },
        body: JSON.stringify({
          action: "apply",
          companionId: memoryCompanion.id,
          proposals: selected.map((proposal) => ({
            memoryIds: proposal.memoryIds,
            mergedContent: proposal.mergedContent,
          })),
        }),
      });
      const data = (await response.json()) as {
        mergedGroups?: number;
        removedCopies?: number;
        notionWarning?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "The duplicate merges could not be saved.");
      const appliedIds = new Set(selected.map((proposal) => proposal.id));
      setDuplicateProposals((current) => current.filter((proposal) => !appliedIds.has(proposal.id)));
      setSelectedDuplicateProposalIds([]);
      await searchMemories("", memoryShelf);
      setNotice(
        `${data.mergedGroups || 0} duplicate ${data.mergedGroups === 1 ? "group" : "groups"} merged · ${data.removedCopies || 0} redundant ${data.removedCopies === 1 ? "copy" : "copies"} retired.${data.notionWarning ? ` Memory is saved, but Notion reported: ${data.notionWarning}` : " Supabase and Notion were synchronized."}`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The duplicate merges could not be saved.");
    } finally {
      setMergingDuplicates(false);
    }
  }

  async function importMemoryFiles(files: FileList | null) {
    const selected = Array.from(files || []);
    if (!selected.length) return;
    setImportingMemory(true);
    setNotice(
      selected.length === 1
        ? `${selected[0].name} received · reading and filing its memories now…`
        : `${selected.length} files received · reading and filing their memories now…`,
    );
    let imported = 0;
    let shared = 0;
    let privateCount = 0;
    try {
      for (const file of selected) {
        const lowerName = file.name.toLocaleLowerCase();
        const isPdf = file.type === "application/pdf" || lowerName.endsWith(".pdf");
        let chunks: Array<File | Blob> = [file];
        let characterCount = 0;
        let truncated = false;
        if (!isPdf) {
          let source = "";
          if (lowerName.endsWith(".zip")) {
            const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
            const sections: string[] = [];
            let total = 0;
            for (const [name, bytes] of Object.entries(archive)) {
              if (!/\.(txt|md|json|jsonl|csv|tsv|html|xml)$/i.test(name)) continue;
              const decoded = strFromU8(bytes);
              if (!decoded.trim()) continue;
              const remaining = 600_000 - total;
              if (remaining <= 0) {
                truncated = true;
                break;
              }
              const section = `\n\n--- ${name} ---\n${decoded.slice(0, remaining)}`;
              sections.push(section);
              total += section.length;
              if (decoded.length > remaining) truncated = true;
            }
            if (!sections.length) {
              throw new Error(
                `${file.name} has no readable text, Markdown, JSON, CSV, or HTML files.`,
              );
            }
            source = sections.join("");
          } else {
            source = await file.text();
          }
          characterCount = source.length;
          const allChunks = Array.from(
            { length: Math.max(1, Math.ceil(source.length / 16_000)) },
            (_, index) =>
              new Blob(
                [source.slice(index * 16_000, (index + 1) * 16_000)],
                { type: "text/plain" },
              ),
          );
          if (allChunks.length > 38) truncated = true;
          chunks = allChunks.slice(0, 38);
        }

        const sourceForm = new FormData();
        sourceForm.set("file", file, file.name);
        sourceForm.set("sourceOnly", "true");
        sourceForm.set("originalName", file.name);
        sourceForm.set("parts", String(chunks.length));
        sourceForm.set("companionId", memoryCompanion.id);
        sourceForm.set("characterCount", String(characterCount));
        sourceForm.set("truncated", String(truncated));
        const sourceResponse = await fetch("/api/memory/import", {
          method: "POST",
          body: sourceForm,
        });
        const sourceData = (await sourceResponse.json()) as {
          importId?: string;
          error?: string;
        };
        if (!sourceResponse.ok || !sourceData.importId) {
          throw new Error(sourceData.error || `${file.name} could not be preserved.`);
        }

        for (const [index, chunk] of chunks.entries()) {
          setMemoryImportProgress(
            `${file.name} · section ${index + 1} of ${chunks.length}`,
          );
          const form = new FormData();
          form.set(
            "file",
            chunk,
            isPdf ? file.name : `${file.name}.part-${index + 1}.txt`,
          );
          form.set("originalName", file.name);
          form.set("part", String(index + 1));
          form.set("parts", String(chunks.length));
          form.set("companionId", memoryCompanion.id);
          form.set("importId", sourceData.importId);
          const response = await fetch("/api/memory/import", {
            method: "POST",
            headers: {
              ...(deviceKeys[memoryCompanion.provider]
                ? { "x-companion-provider-key": deviceKeys[memoryCompanion.provider] }
                : {}),
            },
            body: form,
          });
          const responseText = await response.text();
          let data: {
            imported?: number;
            shared?: number;
            private?: number;
            error?: string;
          };
          try {
            data = JSON.parse(responseText) as typeof data;
          } catch {
            data = {
              error:
                response.status === 524
                  ? "That section exceeded the provider time limit."
                  : responseText.slice(0, 240),
            };
          }
          if (!response.ok) {
            throw new Error(
              data.error ||
                `${file.name}, section ${index + 1}, could not be imported.`,
            );
          }
          imported += data.imported || 0;
          shared += data.shared || 0;
          privateCount += data.private || 0;
        }
      }
      setNotice(
        `Memory import complete · ${imported} new items filed automatically · ${shared} Everyone · ${privateCount} ${memoryCompanion.name}. Original files were preserved with an import audit.`,
      );
      if (supabaseUrl && supabaseKey) {
        await fetch("/api/supabase-memory", {
          method: "POST",
          headers: supabaseHeaders(),
        });
      }
      if (notionToken && editingProfile.notionSource.trim()) {
        await syncNotion();
      }
      await searchMemories("", memoryShelf);
      await loadMemoryImports();
      void refreshUsage();
      void refreshOpenRouterCredits();
      await scanSemanticDuplicates(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Memory import failed.");
    } finally {
      setImportingMemory(false);
      setMemoryImportProgress("");
      if (memoryImportInputRef.current) memoryImportInputRef.current.value = "";
    }
  }

  async function syncNotion() {
    const token = notionToken || notionTokenDraft.trim();
    const source = editingProfile.notionSource.trim();
    const destinationShelf = notionDestination;
    const destinationName = destinationShelf === "shared" ? "Everyone" : memoryCompanion.name;
    if (token.length < 20) {
      setNotice("Save the Notion integration token on this device first.");
      return;
    }
    if (!source) {
      setNotice("Paste the Notion page or database URL first.");
      return;
    }
    setSyncingNotion(true);
    try {
      const savedProfile = await saveMemorySettings(false);
      if (!savedProfile) return;
      const response = await fetch("/api/notion", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-companion-notion-key": token,
          ...supabaseHeaders(),
        },
        body: JSON.stringify({
          action: "sync",
          source,
          companionId: destinationShelf === "shared" ? "shared" : memoryCompanion.id,
          counterpartId: memoryCompanion.id,
          relocate: true,
        }),
      });
      const data = (await response.json()) as {
        name?: string;
        sourceType?: "page" | "data_source";
        pages?: number;
        imported?: number;
        mirrored?: number;
        editedMirrorCount?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "Notion sync failed.");
      setNotice(
        `${data.name || "Notion"} synced both ways · ${data.pages || 0} ${data.pages === 1 ? "page" : "pages"} read · ${data.imported || 0} searchable ${data.imported === 1 ? "chunk" : "chunks"} filed to ${destinationName} · ${data.mirrored || 0} app ${data.mirrored === 1 ? "memory" : "memories"} mirrored${data.editedMirrorCount ? ` · ${data.editedMirrorCount} Notion ${data.editedMirrorCount === 1 ? "edit" : "edits"} pulled back` : ""}.`,
      );
      setMemoryShelf(destinationShelf);
      setMemoryQuery("");
      await searchMemories("", destinationShelf);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Notion sync failed.");
    } finally {
      setSyncingNotion(false);
    }
  }

  async function attachFiles(files: FileList | null) {
    if (!files?.length || uploadingAttachments || sending) return;
    const selected = Array.from(files).slice(0, Math.max(0, 4 - pendingAttachments.length));
    if (!selected.length) {
      setNotice("Four attachments can travel with one message.");
      return;
    }
    setUploadingAttachments(true);
    setNotice(null);
    try {
      for (const file of selected) {
        const form = new FormData();
        form.append("conversationId", activeConversationId);
        form.append("file", file);
        const response = await fetch("/api/attachments", {
          method: "POST",
          body: form,
        });
        const data = (await response.json()) as {
          attachment?: Attachment;
          error?: string;
        };
        if (!response.ok || !data.attachment) {
          throw new Error(data.error || `${file.name} could not be attached.`);
        }
        setPendingAttachments((current) => [...current, data.attachment as Attachment]);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The attachment could not be added.");
    } finally {
      setUploadingAttachments(false);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    }
  }

  async function removePendingAttachment(attachment: Attachment) {
    setPendingAttachments((current) =>
      current.filter((item) => item.id !== attachment.id),
    );
    await fetch(`/api/attachments/${encodeURIComponent(attachment.id)}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }

  function insertGroupMention(name: string) {
    const mention = `@${name}`;
    setDraft((current) => {
      let nextDraft = current;
      if (name.toLocaleLowerCase() === "everyone") {
        for (const member of activeConversation?.members || []) {
          nextDraft = nextDraft.replace(
            new RegExp(
              `(^|\\s)@${escapePattern(member.name)}(?=\\s|[.,!?;:]|$)`,
              "gi",
            ),
            "$1",
          );
        }
      } else {
        nextDraft = nextDraft.replace(
          /(^|\s)@everyone(?=\s|[.,!?;:]|$)/gi,
          "$1",
        );
      }
      const alreadyIncluded = new RegExp(
        `(^|\\s)${escapePattern(mention)}(?=\\s|[.,!?;:]|$)`,
        "i",
      ).test(nextDraft);
      if (alreadyIncluded) return nextDraft;
      const prefix = nextDraft.trimEnd().replace(/[ \t]{2,}/g, " ");
      return `${prefix}${prefix ? " " : ""}${mention} `;
    });
    requestAnimationFrame(() => composerTextareaRef.current?.focus());
  }

  function beginEditingMessage(message: Message) {
    setEditingMessageId(message.id);
    setEditingMessageDraft(message.body);
  }

  async function reviseMessage(
    message: Message,
    mode: "edit" | "retry",
  ) {
    if (sending || !activeConversation) return;
    const targetIndex = messages.findIndex((item) => item.id === message.id);
    if (targetIndex < 0) return;
    const editedContent = editingMessageDraft.trim();
    if (mode === "edit" && !editedContent) {
      setNotice("An edited message needs text.");
      return;
    }
    if (
      targetIndex < messages.length - 1 &&
      !window.confirm(
        mode === "edit"
          ? "Editing this message will rewind the replies and messages after it. Continue?"
          : "Retrying this reply will rewind the messages after it. Continue?",
      )
    ) {
      return;
    }
    if (usage.totalCost >= usage.monthlyBudget) {
      setNotice(
        "The Companion Lab monthly budget has been reached. Raise it in Spending before requesting another reply.",
      );
      return;
    }

    const replyCompanion =
      activeConversation.kind === "solo"
        ? companions.find(
            (item) => item.id === activeConversation.companionId,
          ) || companion
        : mode === "retry"
          ? companions.find((item) => item.id === message.companionId) || companion
          : companions.find(
              (item) =>
                item.id ===
                messages
                  .slice(targetIndex + 1)
                  .find((item) => item.role === "assistant")?.companionId,
            ) ||
            companions.find((item) => item.id === groupSpeakerId) ||
            companion;
    const replyMember = activeConversation.members.find(
      (member) => member.id === replyCompanion.id,
    );
    const replyProvider = replyMember?.provider || replyCompanion.provider;
    const revisionTurnId = crypto.randomUUID();
    const editedAudience =
      activeConversation.kind === "group" && mode === "edit"
        ? mentionedMemberIds(editedContent, activeConversation.members)
        : [];
    const revisionAudience = editedAudience.length
      ? editedAudience
      : [replyCompanion.id];
    const optimisticAssistantId = `local-revision-${Date.now()}-${replyCompanion.id}`;
    const baseMessages =
      mode === "edit"
        ? messages.slice(0, targetIndex + 1).map((item) =>
            item.id === message.id ? { ...item, body: editedContent } : item,
          )
        : messages.slice(0, targetIndex);
    let assistantId = optimisticAssistantId;

    setEditingMessageId(null);
    setEditingMessageDraft("");
    setNotice(null);
    setSending(true);
    setMessages([
      ...baseMessages,
      {
        id: optimisticAssistantId,
        role: "assistant",
        body: "",
        createdAt: new Date().toISOString(),
        status: "streaming",
        companionId: replyCompanion.id,
        companionName: replyCompanion.name,
        speakerId: replyCompanion.id,
        speakerName: replyCompanion.name,
        replyToSpeakerName:
          activeConversation.kind === "group" ? "Becca" : null,
        turnId: revisionTurnId,
      },
    ]);

    try {
      const response = await fetch(
        `/api/chat?conversationId=${encodeURIComponent(activeConversation.id)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...supabaseHeaders(),
            ...(webSearchEnabled ? { "x-companion-web-search": "enabled" } : {}),
            ...(deviceKeys[replyProvider]
              ? {
                  "x-companion-provider-key":
                    deviceKeys[replyProvider],
                }
              : {}),
          },
          body: JSON.stringify({
            conversationId: activeConversation.id,
            content: mode === "edit" ? editedContent : "",
            companionId: replyCompanion.id,
            addressedCompanionIds:
              mode === "edit" ? revisionAudience : [],
            turnId: revisionTurnId,
            attachmentIds: [],
            ...(mode === "edit"
              ? { editMessageId: message.id }
              : { retryMessageId: message.id }),
          }),
        },
      );
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "The revised reply could not be started.");
      }
      if (!response.body) throw new Error("The provider returned an empty stream.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const streamEvent = JSON.parse(line) as {
            type: "accepted" | "delta" | "done" | "error";
            text?: string;
            message?: string;
            assistantMessageId?: string;
            messageId?: string;
            replyToMessageId?: string | null;
            turnId?: string;
            costUsd?: number | null;
            provider?: Companion["provider"];
            model?: string;
            usage?: {
              inputTokens?: number;
              outputTokens?: number;
              cacheWriteTokens?: number;
              cacheReadTokens?: number;
            };
          };
          if (streamEvent.type === "accepted") {
            assistantId =
              streamEvent.assistantMessageId || optimisticAssistantId;
            setMessages((current) =>
              current.map((item) =>
                item.id === optimisticAssistantId
                  ? { ...item, id: assistantId }
                  : item,
              ),
            );
          } else if (streamEvent.type === "delta" && streamEvent.text) {
            setMessages((current) =>
              current.map((item) =>
                item.id === assistantId
                  ? { ...item, body: item.body + streamEvent.text }
                  : item,
              ),
            );
          } else if (streamEvent.type === "done") {
            const previousAssistantId = assistantId;
            assistantId = streamEvent.messageId || assistantId;
            setMessages((current) =>
              current.map((item) =>
                item.id === previousAssistantId
                  ? {
                      ...item,
                      id: assistantId,
                      status: "complete",
                      replyToMessageId:
                        streamEvent.replyToMessageId ||
                        item.replyToMessageId,
                      turnId: streamEvent.turnId || item.turnId,
                      inputTokens: streamEvent.usage?.inputTokens || 0,
                      outputTokens: streamEvent.usage?.outputTokens || 0,
                      cacheWriteTokens:
                        streamEvent.usage?.cacheWriteTokens || 0,
                      cacheReadTokens:
                        streamEvent.usage?.cacheReadTokens || 0,
                      costUsd: streamEvent.costUsd ?? null,
                      costSource:
                        (streamEvent.provider || replyProvider) === "openrouter"
                          ? "reported"
                          : "estimated",
                    }
                  : item,
              ),
            );
          } else if (streamEvent.type === "error") {
            throw new Error(
              streamEvent.message || "The revised reply failed.",
            );
          }
        }
        if (done) break;
      }
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "The revised reply could not be completed.",
      );
      await loadMessages(activeConversation.id).catch(() => undefined);
    } finally {
      setSending(false);
      void refreshConversations();
      void refreshUsage();
      void refreshOpenRouterCredits();
    }
  }

  async function submitMessage(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if ((!body && !pendingAttachments.length) || sending || uploadingAttachments) return;
    if (usage.totalCost >= usage.monthlyBudget) {
      setNotice(
        "The Companion Lab monthly budget has been reached. Raise it in Spending before sending another billed reply.",
      );
      return;
    }
    const now = new Date().toISOString();
    const conversationId = activeConversationId;
    const optimisticUserId = `local-user-${Date.now()}`;
    const turnId = crypto.randomUUID();
    const sendingAttachments = pendingAttachments;
    const roomMembers = activeConversation?.members || [];
    const mentioned = activeConversation?.kind === "group"
      ? mentionedMemberIds(body, roomMembers)
      : [];
    const initialTargets =
      activeConversation?.kind === "group"
        ? mentioned.length
          ? mentioned
          : [groupSpeakerId]
        : [companion.id];
    const uniqueInitialTargets = initialTargets.filter(
      (id, index) => initialTargets.indexOf(id) === index,
    );
    setMessages((current) => [
      ...current,
      {
        id: optimisticUserId,
        role: "user",
        body,
        attachments: sendingAttachments,
        createdAt: now,
        speakerId: "becca",
        speakerName: "Becca",
        audience: uniqueInitialTargets,
        turnId,
      },
    ]);
    setDraft("");
    setNotice(null);
    setSending(true);
    let messageCommitted = false;
    let roomUserMessageId = optimisticUserId;

    if (activeConversation?.kind === "group") {
      setGroupTurn({
        turnId,
        members: uniqueInitialTargets.map((id) => {
          const member = roomMembers.find((item) => item.id === id);
          return {
            id,
            name:
              member?.name ||
              companions.find((item) => item.id === id)?.name ||
              "Companion",
            status: "queued",
          };
        }),
      });
    } else {
      setGroupTurn(null);
    }

    try {
      if (activeConversation?.kind === "group") {
        const response = await fetch(
          `/api/chat?conversationId=${encodeURIComponent(conversationId)}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...supabaseHeaders(),
              ...(webSearchEnabled ? { "x-companion-web-search": "enabled" } : {}),
            },
            body: JSON.stringify({
              conversationId,
              content: body,
              addressedCompanionIds: uniqueInitialTargets,
              turnId,
              attachmentIds: sendingAttachments.map(
                (attachment) => attachment.id,
              ),
              providerKeys: deviceKeys,
              orchestrateGroup: true,
            }),
          },
        );
        if (!response.ok) {
          const data = (await response.json()) as { error?: string };
          throw new Error(data.error || "The group turn could not be started.");
        }
        if (!response.body) {
          throw new Error("The group room returned an empty stream.");
        }

        const speakerStreams = new Map<
          number,
          {
            optimisticId: string;
            assistantId: string;
            companionId: string;
            companionName: string;
          }
        >();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            const streamEvent = JSON.parse(line) as {
              type:
                | "group_accepted"
                | "speaker_start"
                | "accepted"
                | "delta"
                | "done"
                | "speaker_error"
                | "handoff_queued"
                | "group_done"
                | "group_error";
              sequence?: number;
              text?: string;
              message?: string;
              userMessageId?: string | null;
              assistantMessageId?: string;
              messageId?: string;
              companionId?: string;
              companionName?: string;
              replyToMessageId?: string | null;
              replyToSpeakerName?: string;
              turnId?: string;
              costUsd?: number | null;
              provider?: Companion["provider"];
              usage?: {
                inputTokens?: number;
                outputTokens?: number;
                cacheWriteTokens?: number;
                cacheReadTokens?: number;
              };
              memoryUpdate?: {
                processed: boolean;
                saved: number;
                shared: number;
                private: number;
              } | null;
              handoffCompanionIds?: string[];
              completed?: Array<{ companionId: string; name: string }>;
              failures?: Array<{
                companionId: string;
                name: string;
                error: string;
              }>;
            };

            if (streamEvent.type === "speaker_start") {
              const sequence = streamEvent.sequence ?? speakerStreams.size;
              const companionId = streamEvent.companionId || "";
              const replyCompanion =
                companions.find((item) => item.id === companionId) || companion;
              const optimisticAssistantId =
                `local-group-assistant-${turnId}-${sequence}`;
              speakerStreams.set(sequence, {
                optimisticId: optimisticAssistantId,
                assistantId: optimisticAssistantId,
                companionId: replyCompanion.id,
                companionName:
                  streamEvent.companionName || replyCompanion.name,
              });
              setGroupTurn((current) =>
                current?.turnId === turnId
                  ? {
                      ...current,
                      members: current.members.some(
                        (member) => member.id === replyCompanion.id,
                      )
                        ? current.members.map((member) =>
                            member.id === replyCompanion.id
                              ? {
                                  ...member,
                                  status: "responding",
                                  error: undefined,
                                }
                              : member,
                          )
                        : [
                            ...current.members,
                            {
                              id: replyCompanion.id,
                              name:
                                streamEvent.companionName ||
                                replyCompanion.name,
                              status: "responding",
                            },
                          ],
                    }
                  : current,
              );
              setMessages((current) => [
                ...current,
                {
                  id: optimisticAssistantId,
                  role: "assistant",
                  body: "",
                  createdAt: new Date().toISOString(),
                  status: "streaming",
                  companionId: replyCompanion.id,
                  companionName:
                    streamEvent.companionName || replyCompanion.name,
                  speakerId: replyCompanion.id,
                  speakerName:
                    streamEvent.companionName || replyCompanion.name,
                  replyToMessageId:
                    streamEvent.replyToMessageId ||
                    (streamEvent.replyToSpeakerName === "Becca"
                      ? roomUserMessageId
                      : null),
                  replyToSpeakerName:
                    streamEvent.replyToSpeakerName || "Becca",
                  turnId,
                },
              ]);
            } else if (
              streamEvent.type === "accepted" &&
              typeof streamEvent.sequence === "number"
            ) {
              const speakerStream = speakerStreams.get(streamEvent.sequence);
              if (!speakerStream) continue;
              if (streamEvent.userMessageId) {
                roomUserMessageId = streamEvent.userMessageId;
                messageCommitted = true;
                setPendingAttachments([]);
              }
              const previousAssistantId = speakerStream.assistantId;
              speakerStream.assistantId =
                streamEvent.assistantMessageId ||
                speakerStream.assistantId;
              liveStreamIdsRef.current.add(speakerStream.assistantId);
              setMessages((current) =>
                current.map((message) => {
                  if (
                    message.id === optimisticUserId &&
                    streamEvent.userMessageId
                  ) {
                    return { ...message, id: streamEvent.userMessageId };
                  }
                  if (
                    message.id === previousAssistantId ||
                    message.id === speakerStream.optimisticId
                  ) {
                    return {
                      ...message,
                      id: speakerStream.assistantId,
                      replyToMessageId:
                        message.replyToMessageId === optimisticUserId &&
                        streamEvent.userMessageId
                          ? streamEvent.userMessageId
                          : message.replyToMessageId,
                    };
                  }
                  return message;
                }),
              );
            } else if (
              streamEvent.type === "delta" &&
              typeof streamEvent.sequence === "number" &&
              streamEvent.text
            ) {
              const speakerStream = speakerStreams.get(streamEvent.sequence);
              if (!speakerStream) continue;
              setMessages((current) =>
                current.map((message) =>
                  message.id === speakerStream.assistantId
                    ? { ...message, body: message.body + streamEvent.text }
                    : message,
                ),
              );
            } else if (
              streamEvent.type === "done" &&
              typeof streamEvent.sequence === "number"
            ) {
              const speakerStream = speakerStreams.get(streamEvent.sequence);
              if (!speakerStream) continue;
              const previousAssistantId = speakerStream.assistantId;
              speakerStream.assistantId =
                streamEvent.messageId || speakerStream.assistantId;
              setMessages((current) =>
                current.map((message) =>
                  message.id === previousAssistantId
                    ? {
                        ...message,
                        id: speakerStream.assistantId,
                        status: "complete",
                        replyToMessageId:
                          streamEvent.replyToMessageId ||
                          message.replyToMessageId,
                        turnId: streamEvent.turnId || message.turnId,
                        inputTokens: streamEvent.usage?.inputTokens || 0,
                        outputTokens: streamEvent.usage?.outputTokens || 0,
                        cacheWriteTokens:
                          streamEvent.usage?.cacheWriteTokens || 0,
                        cacheReadTokens:
                          streamEvent.usage?.cacheReadTokens || 0,
                        costUsd: streamEvent.costUsd ?? null,
                        costSource:
                          streamEvent.provider === "openrouter"
                            ? "reported"
                            : "estimated",
                        audience: streamEvent.handoffCompanionIds || [],
                      }
                    : message,
                ),
              );
              setGroupTurn((current) =>
                current?.turnId === turnId
                  ? {
                      ...current,
                      members: current.members.map((member) =>
                        member.id === speakerStream.companionId
                          ? {
                              ...member,
                              status: "complete",
                              error: undefined,
                            }
                          : member,
                      ),
                    }
                  : current,
              );
              if (streamEvent.memoryUpdate?.saved) {
                setNotice(
                  `${streamEvent.memoryUpdate.saved} ${
                    streamEvent.memoryUpdate.saved === 1
                      ? "memory"
                      : "memories"
                  } carried forward.`,
                );
              }
            } else if (streamEvent.type === "handoff_queued") {
              const handoffCompanion =
                companions.find(
                  (item) => item.id === streamEvent.companionId,
                ) || companion;
              setGroupTurn((current) =>
                current?.turnId === turnId &&
                !current.members.some(
                  (member) => member.id === handoffCompanion.id,
                )
                  ? {
                      ...current,
                      members: [
                        ...current.members,
                        {
                          id: handoffCompanion.id,
                          name:
                            streamEvent.companionName ||
                            handoffCompanion.name,
                          status: "queued",
                        },
                      ],
                    }
                  : current,
              );
            } else if (streamEvent.type === "speaker_error") {
              const sequence = streamEvent.sequence;
              const speakerStream =
                typeof sequence === "number"
                  ? speakerStreams.get(sequence)
                  : undefined;
              if (streamEvent.userMessageId) {
                roomUserMessageId = streamEvent.userMessageId;
                messageCommitted = true;
                setPendingAttachments([]);
                setMessages((current) =>
                  current.map((message) =>
                    message.id === optimisticUserId
                      ? { ...message, id: streamEvent.userMessageId as string }
                      : message,
                  ),
                );
              }
              if (speakerStream) {
                setMessages((current) =>
                  current.filter(
                    (message) =>
                      message.id !== speakerStream.assistantId &&
                      message.id !== speakerStream.optimisticId,
                  ),
                );
              }
              setGroupTurn((current) =>
                current?.turnId === turnId
                  ? {
                      ...current,
                      members: current.members.map((member) =>
                        member.id === streamEvent.companionId
                          ? {
                              ...member,
                              status: "failed",
                              error:
                                streamEvent.message ||
                                "The reply could not be completed.",
                            }
                          : member,
                      ),
                    }
                  : current,
              );
            } else if (streamEvent.type === "group_done") {
              if (streamEvent.userMessageId) {
                roomUserMessageId = streamEvent.userMessageId;
                messageCommitted = true;
                setPendingAttachments([]);
                setMessages((current) =>
                  current.map((message) =>
                    message.id === optimisticUserId
                      ? { ...message, id: streamEvent.userMessageId as string }
                      : message,
                  ),
                );
              }
              if (streamEvent.failures?.length) {
                const failedNames = streamEvent.failures
                  .map((failure) => failure.name)
                  .join(", ");
                const completedNames = (streamEvent.completed || [])
                  .map((completed) => completed.name)
                  .join(", ");
                setNotice(
                  `${failedNames} could not answer after retry.${
                    completedNames
                      ? ` ${completedNames} completed the group turn.`
                      : ""
                  }`,
                );
              }
            } else if (streamEvent.type === "group_error") {
              if (streamEvent.userMessageId) {
                messageCommitted = true;
              }
              throw new Error(
                streamEvent.message ||
                  "The group turn could not be completed.",
              );
            }
          }
          if (done) break;
        }
        return;
      }

      const soloReplyQueue = uniqueInitialTargets.map((companionId) => ({
        companionId,
        replyToMessageId: optimisticUserId,
        replyToSpeakerName: "Becca",
      }));
      for (
        let replyIndex = 0;
        replyIndex < soloReplyQueue.length;
        replyIndex += 1
      ) {
        const queuedReply = soloReplyQueue[replyIndex];
        const companionId = queuedReply.companionId;
        const replyCompanion =
          companions.find((item) => item.id === companionId) || companion;
        const replyMember = activeConversation?.members.find(
          (member) => member.id === replyCompanion.id,
        );
        const replyProvider = replyMember?.provider || replyCompanion.provider;
        const continuing = false;
        const replyToMessageId = queuedReply.replyToMessageId;
        const optimisticAssistantId =
          `local-assistant-${Date.now()}-${replyIndex}-${replyCompanion.id}`;
        let assistantId = optimisticAssistantId;
        setGroupSpeakerId(replyCompanion.id);
        setMessages((current) => [
          ...current,
          {
            id: optimisticAssistantId,
            role: "assistant",
            body: "",
            createdAt: new Date().toISOString(),
            status: "streaming",
            companionId: replyCompanion.id,
            companionName: replyCompanion.name,
            speakerId: replyCompanion.id,
            speakerName: replyCompanion.name,
            replyToMessageId,
            replyToSpeakerName: queuedReply.replyToSpeakerName,
            turnId,
          },
        ]);

        try {
          const response = await fetch(
            `/api/chat?conversationId=${encodeURIComponent(conversationId)}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...supabaseHeaders(),
                ...(webSearchEnabled ? { "x-companion-web-search": "enabled" } : {}),
                ...(deviceKeys[replyProvider]
                  ? { "x-companion-provider-key": deviceKeys[replyProvider] }
                  : {}),
              },
              body: JSON.stringify({
                conversationId,
                content: continuing ? "" : body,
                companionId: replyCompanion.id,
                addressedCompanionIds: continuing
                  ? []
                  : uniqueInitialTargets,
                turnId,
                replyToMessageId: continuing ? replyToMessageId : "",
                attachmentIds: continuing
                  ? []
                  : sendingAttachments.map((attachment) => attachment.id),
                continueConversation: continuing,
              }),
            },
          );
          if (!response.ok) {
            const data = (await response.json()) as {
              error?: string;
              userMessageId?: string;
            };
            if (data.userMessageId) {
              messageCommitted = true;
              roomUserMessageId = data.userMessageId;
              setPendingAttachments([]);
              setMessages((current) =>
                current.map((message) =>
                  message.id === optimisticUserId
                    ? { ...message, id: data.userMessageId as string }
                    : message,
                ),
              );
            }
            throw new Error(data.error || "The reply could not be started.");
          }
          if (!response.body) throw new Error("The provider returned an empty stream.");

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim()) continue;
              const streamEvent = JSON.parse(line) as {
                type: "accepted" | "delta" | "done" | "error";
                text?: string;
                message?: string;
                userMessageId?: string;
                assistantMessageId?: string;
                messageId?: string;
                replyToMessageId?: string | null;
                turnId?: string;
                costUsd?: number | null;
                provider?: Companion["provider"];
                model?: string;
                usage?: {
                  inputTokens?: number;
                  outputTokens?: number;
                  cacheWriteTokens?: number;
                  cacheReadTokens?: number;
                };
                memoryUpdate?: {
                  processed: boolean;
                  saved: number;
                  shared: number;
                  private: number;
                } | null;
              };
              if (streamEvent.type === "accepted") {
                if (!continuing) {
                  messageCommitted = true;
                  setPendingAttachments([]);
                }
                if (streamEvent.userMessageId) {
                  roomUserMessageId = streamEvent.userMessageId;
                }
                assistantId = streamEvent.assistantMessageId || assistantId;
                liveStreamIdsRef.current.add(assistantId);
                setMessages((current) =>
                  current.map((message) => {
                    if (
                      message.id === optimisticUserId &&
                      streamEvent.userMessageId
                    ) {
                      return { ...message, id: streamEvent.userMessageId };
                    }
                    if (message.id === optimisticAssistantId) {
                      return {
                        ...message,
                        id: assistantId,
                        replyToMessageId:
                          message.replyToMessageId === optimisticUserId &&
                          streamEvent.userMessageId
                            ? streamEvent.userMessageId
                            : message.replyToMessageId,
                      };
                    }
                    return message;
                  }),
                );
              } else if (streamEvent.type === "delta" && streamEvent.text) {
                setMessages((current) =>
                  current.map((message) =>
                    message.id === assistantId
                      ? { ...message, body: message.body + streamEvent.text }
                      : message,
                  ),
                );
              } else if (streamEvent.type === "done") {
                const previousAssistantId = assistantId;
                assistantId = streamEvent.messageId || assistantId;
                setMessages((current) =>
                  current.map((message) =>
                    message.id === previousAssistantId
                      ? {
                          ...message,
                          id: assistantId,
                          status: "complete",
                          replyToMessageId:
                            streamEvent.replyToMessageId ||
                            message.replyToMessageId,
                          turnId: streamEvent.turnId || message.turnId,
                          inputTokens: streamEvent.usage?.inputTokens || 0,
                          outputTokens: streamEvent.usage?.outputTokens || 0,
                          cacheWriteTokens:
                            streamEvent.usage?.cacheWriteTokens || 0,
                          cacheReadTokens:
                            streamEvent.usage?.cacheReadTokens || 0,
                          costUsd: streamEvent.costUsd ?? null,
                          costSource:
                            (streamEvent.provider || replyProvider) === "openrouter"
                              ? "reported"
                              : "estimated",
                        }
                      : message,
                  ),
                );
                if (streamEvent.memoryUpdate?.saved) {
                  setNotice(
                    `${streamEvent.memoryUpdate.saved} ${streamEvent.memoryUpdate.saved === 1 ? "memory" : "memories"} carried forward · ${streamEvent.memoryUpdate.shared} Everyone · ${streamEvent.memoryUpdate.private} ${replyCompanion.name}.`,
                  );
                }
              } else if (streamEvent.type === "error") {
                throw new Error(streamEvent.message || "The streamed reply failed.");
              }
            }
            if (done) break;
          }
        } catch (error) {
          setMessages((current) =>
            current.filter(
              (message) =>
                message.id !== assistantId &&
                message.id !== optimisticAssistantId,
              ),
          );
          throw error;
        }
      }
    } catch (error) {
      if (!messageCommitted) setDraft(body);
      const connectionDropped = messageCommitted && error instanceof TypeError;
      setNotice(
        connectionDropped
          ? "The connection dropped, but the reply keeps writing — it will appear here as it finishes."
          : error instanceof Error
            ? error.message
            : "The reply could not be completed.",
      );
      setMessages((current) =>
        current.filter(
          (message) =>
            (messageCommitted || message.id !== optimisticUserId),
        ),
      );
      if (messageCommitted) {
        await loadMessages(conversationId).catch(() => undefined);
      }
    } finally {
      setSending(false);
      liveStreamIdsRef.current.clear();
      // If the viewer is looking at the thread this stream fed (they may
      // have switched away and back mid-reply), reload it from the server
      // so the stored reply text is authoritative and gap-free.
      if (activeConversationIdRef.current === conversationId) {
        void loadMessages(conversationId).catch(() => undefined);
      }
      void refreshConversations().catch(() => undefined);
      void refreshUsage();
      void refreshOpenRouterCredits();
    }
  }

  const previewCompanion = studioTab ? editing : companion;
  const editingModels = modelCatalogs[editing.provider];
  const displayedModels = editingModels.some((model) => model.id === editing.model)
    ? editingModels
    : [{ id: editing.model, label: editing.model }, ...editingModels];
  const messageCompanion = (message: Message) =>
    companions.find((item) => item.id === message.companionId) || companion;
  const composerMentionsEveryone =
    activeConversation?.kind === "group" && mentionsEveryone(draft);
  const composerAudienceIds =
    activeConversation?.kind === "group" && !composerMentionsEveryone
      ? mentionedMemberIds(draft, activeConversation.members)
      : [];

  const renderChatRow = (conversation: Conversation) => (
    <div
      className="chat-row"
      data-active={conversation.id === activeConversationId || undefined}
      data-menu-open={menuConversationId === conversation.id || undefined}
      key={conversation.id}
    >
      {renamingConversationId === conversation.id ? (
        <form
          className="rename-chat-form"
          onSubmit={(event) => {
            event.preventDefault();
            void renameConversation();
          }}
        >
          <input
            autoFocus
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            aria-label="Chat name"
          />
          <button type="submit" aria-label="Save chat name">✓</button>
          <button
            type="button"
            aria-label="Cancel rename"
            onClick={() => setRenamingConversationId(null)}
          >
            ×
          </button>
        </form>
      ) : (
        <>
          <button
            className="chat-row-main"
            onClick={() => void selectConversation(conversation.id)}
            disabled={loadingConversation}
          >
            <span
              className="avatar small"
              data-group={conversation.kind === "group" || undefined}
              style={
                {
                  "--avatar-color":
                    conversation.members[0]?.accent || companion.accent,
                } as React.CSSProperties
              }
            >
              {conversation.kind === "group"
                ? conversation.members.length
                : (conversation.members[0]?.name || companion.name)
                    .slice(0, 1)
                    .toUpperCase()}
            </span>
            <span className="chat-copy">
              <strong>
                {conversation.pinnedAt ? "📌 " : ""}
                {conversation.title}
              </strong>
              <small>
                <b>{conversation.kind === "group" ? "Group" : conversation.members[0]?.name}</b>
                {" · "}
                {conversation.preview ||
                  (conversation.messageCount
                    ? `${conversation.messageCount} messages`
                    : "Clean thread")}
              </small>
            </span>
            {conversation.id === activeConversationId && (
              <span className="status-dot" aria-label="Current conversation" />
            )}
          </button>
          <button
            className="chat-row-more"
            aria-label={`Options for ${conversation.title}`}
            aria-expanded={menuConversationId === conversation.id}
            onClick={() => {
              setMovePickerConversationId(null);
              setMenuConversationId(
                menuConversationId === conversation.id ? null : conversation.id,
              );
            }}
          >
            ⋯
          </button>
          {menuConversationId === conversation.id && (
            <div className="chat-row-menu" role="menu">
              {movePickerConversationId === conversation.id ? (
                <>
                  <p className="chat-row-menu-title">Move to…</p>
                  {folders.map((folder) => (
                    <button
                      key={folder.id}
                      role="menuitem"
                      disabled={conversation.folderId === folder.id}
                      onClick={() => void moveConversationToFolder(conversation, folder.id)}
                    >
                      📁 {folder.name}
                    </button>
                  ))}
                  {conversation.folderId && (
                    <button
                      role="menuitem"
                      onClick={() => void moveConversationToFolder(conversation, null)}
                    >
                      ↩ Back to companion group
                    </button>
                  )}
                  <form
                    className="chat-row-menu-newfolder"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void createFolderAndMove(conversation);
                    }}
                  >
                    <input
                      value={newFolderDraft}
                      onChange={(event) => setNewFolderDraft(event.target.value)}
                      placeholder="New folder name"
                      aria-label="New folder name"
                    />
                    <button type="submit" disabled={!newFolderDraft.trim()}>Add</button>
                  </form>
                </>
              ) : (
                <>
                  <button role="menuitem" onClick={() => void setConversationPinned(conversation)}>
                    {conversation.pinnedAt ? "Unpin" : "Pin to top"}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuConversationId(null);
                      setRenamingConversationId(conversation.id);
                      setRenameDraft(conversation.title);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => setMovePickerConversationId(conversation.id)}
                  >
                    Move to folder…
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuConversationId(null);
                      void setConversationArchived(conversation);
                    }}
                  >
                    {conversation.archivedAt ? "Restore" : "Archive"}
                  </button>
                  <button
                    role="menuitem"
                    className="chat-row-menu-danger"
                    onClick={() => {
                      setMenuConversationId(null);
                      void deleteConversation(conversation);
                    }}
                  >
                    Delete…
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );

  return (
    <main
      className="app-shell"
      data-drop-active={dropActive || undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={
        {
          "--kian": companion.accent,
          "--companion-bubble": previewCompanion.companionBubbleColor,
          "--user-bubble": previewCompanion.userBubbleColor,
        } as React.CSSProperties
      }
    >
      {dropActive && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card">
            <strong>Drop to attach</strong>
            <small>Up to four files travel with one message</small>
          </div>
        </div>
      )}
      <button
        className="mobile-backdrop"
        data-open={sidebarOpen}
        onClick={() => setSidebarOpen(false)}
        aria-label="Close navigation"
      />

      <aside className="sidebar" data-open={sidebarOpen}>
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div><strong>Companion Lab</strong><small>Private workspace</small></div>
          <button className="mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar">×</button>
        </div>

        <button
          className="new-chat"
          onClick={() => openChatCreator("solo")}
          disabled={creatingConversation}
        >
          <Icon><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></Icon>
          {creatingConversation ? "Opening…" : "New chat"}
        </button>

        <div className="sidebar-quick-links">
          <button onClick={() => openStudio("memory")}>
            <span className="avatar small memory-nav-avatar">✦</span>
            <span className="chat-copy"><strong>Memory</strong><small>What they remember</small></span>
          </button>
          <button onClick={() => openStudio("companions")}>
            <span className="avatar small" style={{ "--avatar-color": "#43d6a2" } as React.CSSProperties}>+</span>
            <span className="chat-copy"><strong>Companion Lab</strong><small>Identities &amp; roster</small></span>
          </button>
        </div>

        <button className="install-app" onClick={() => void installApp()}>
          <Icon><svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 19h14" /></svg></Icon>
          {standalone ? "App installed" : "Install Companion Lab"}
        </button>

        <label className="search-box">
          <Icon><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m16 16 4 4" /></svg></Icon>
          <input
            aria-label="Search chats"
            placeholder="Search conversations"
            value={conversationSearch}
            onChange={(event) => setConversationSearch(event.target.value)}
          />
        </label>

        <div className="sidebar-section">
          <div className="section-label">
            <span>
              {conversationFilter === "archived" ? "Archived chats" : "Conversations"}
            </span>
            <select
              aria-label="Organize conversations"
              value={conversationFilter}
              onChange={(event) => setConversationFilter(event.target.value)}
            >
              <option value="all">All rooms</option>
              <option value="solo">Solo chats</option>
              <option value="group">Groups</option>
              <option value="archived">Archived</option>
              {companions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="archived-chats-link"
            data-active={conversationFilter === "archived" || undefined}
            onClick={() =>
              setConversationFilter(
                conversationFilter === "archived" ? "all" : "archived",
              )
            }
          >
            <span aria-hidden="true">
              {conversationFilter === "archived" ? "←" : "⌄"}
            </span>
            <span>
              <strong>
                {conversationFilter === "archived"
                  ? "Back to conversations"
                  : "Archived chats"}
              </strong>
              <small>
                {conversationFilter === "archived"
                  ? "Return to your active rooms"
                  : `${archivedConversationCount} saved`}
              </small>
            </span>
          </button>
          <nav className="conversation-list" aria-label="Conversations">
            {sidebarSections ? (
              <>
                {sidebarSections.pinned.length > 0 && (
                  <section className="chat-section">
                    <p className="chat-section-label">📌 Pinned</p>
                    {sidebarSections.pinned.map(renderChatRow)}
                  </section>
                )}
                {sidebarSections.folderSections.map(({ folder, items }) => (
                  <section className="chat-section" key={folder.id}>
                    <p className="chat-section-label">
                      <span>📁 {folder.name}</span>
                      <button
                        className="chat-section-remove"
                        aria-label={`Remove folder ${folder.name}`}
                        title="Remove folder (chats go back to their groups)"
                        onClick={() => void deleteFolder(folder)}
                      >
                        ×
                      </button>
                    </p>
                    {items.length ? (
                      items.map(renderChatRow)
                    ) : (
                      <p className="chat-section-empty">
                        Empty — move chats here from their ⋯ menu.
                      </p>
                    )}
                  </section>
                ))}
                {sidebarSections.companionSections.map(({ companion: member, items }) => (
                  <section className="chat-section" key={member.id}>
                    <p className="chat-section-label">{member.name}</p>
                    {items.map(renderChatRow)}
                  </section>
                ))}
                {sidebarSections.groupItems.length > 0 && (
                  <section className="chat-section">
                    <p className="chat-section-label">Groups</p>
                    {sidebarSections.groupItems.map(renderChatRow)}
                  </section>
                )}
                {sidebarSections.otherItems.map(renderChatRow)}
              </>
            ) : (
              visibleConversations.map(renderChatRow)
            )}
            {!visibleConversations.length && (
              <p className="conversation-empty">
                {conversationSearch
                  ? "No chats match that search."
                  : conversationFilter === "archived"
                    ? "No archived conversations."
                    : "No conversations yet."}
              </p>
            )}
          </nav>
        </div>

        <div className="sidebar-footer">
          <button onClick={() => openStudio("provider")}>
            <Icon><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></svg></Icon>
            Settings <span>›</span>
          </button>
          <div className="account">
            <span className="avatar user">B</span>
            <span><strong>Becca</strong><small>Owner</small></span>
          </div>
        </div>
      </aside>

      <section className="chat-stage">
        <header className="chat-header">
          <button className="menu-button" onClick={() => setSidebarOpen(true)} aria-label="Open navigation">
            <Icon><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" /></svg></Icon>
          </button>
          <button
            className="companion-heading"
            onClick={() => openStudio(activeConversation?.kind === "group" ? "companions" : "identity")}
            aria-label={
              activeConversation?.kind === "group"
                ? "View group companions"
                : `Edit ${companion.name}`
            }
          >
            <span className="avatar kian" data-group={activeConversation?.kind === "group" || undefined}>
              {activeConversation?.kind === "group"
                ? activeConversation.members.length
                : companion.name.slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>
                {activeConversation?.kind === "group"
                  ? activeConversation.title
                  : companion.name}
              </strong>
              <small>
                <i />{" "}
                {activeConversation?.kind === "group"
                  ? activeConversation.members.map((member) => member.name).join(", ")
                  : loadingConfig
                    ? "Loading identity…"
                    : `Identity saved · version ${companion.version}`}
              </small>
            </span>
          </button>
          <div className="header-actions">
            <label
              className="model-chip chat-model-chip"
              title={`${activeEngineCompanion.name} in this chat`}
            >
              <span className="model-spark">✦</span>
              <span className="chat-model-owner">{activeEngineCompanion.name}</span>
              <select
                aria-label={`Model for ${activeEngineCompanion.name} in this chat`}
                disabled={!activeConversation || sending}
                value={
                  activeEngineMember?.hasModelOverride
                    ? activeEngineSelection
                    : "default"
                }
                onChange={(event) => void setConversationModel(event.target.value)}
              >
                <option value="default">
                  Companion default · {modelLabel(activeEngineCompanion, modelCatalogs)}
                </option>
                {activeEngineMember?.hasModelOverride && !activeEngineModelListed && (
                  <option value={activeEngineSelection}>
                    {providerInfo[activeEngineProvider].name} · {activeEngineModel}
                  </option>
                )}
                {(["anthropic", "openai", "openrouter"] as const).map((provider) => (
                  <optgroup key={provider} label={providerInfo[provider].name}>
                    {modelCatalogs[provider].map((model) => (
                      <option
                        key={`${provider}-${model.id}`}
                        value={JSON.stringify({ provider, model: model.id })}
                      >
                        {model.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <button className="cost-chip" onClick={() => openStudio("budget")}>
              <Icon><svg viewBox="0 0 24 24"><path d="M3 7h18v12H3zM3 10h18M16 15h2" /></svg></Icon>
              <span><strong>${currentSpend.toFixed(4)}</strong> / ${usage.monthlyBudget.toFixed(2)}</span>
              <span className="cost-track" aria-hidden="true"><i style={{ width: `${spendPercent}%` }} /></span>
            </button>
            <button className="group-button" onClick={() => openChatCreator("group")}>
              <Icon><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 19c.5-4 2.5-6 6-6s5.5 2 6 6M15 14c3 0 5 1.7 5.5 5" /></svg></Icon>
              New group chat
            </button>
          </div>
        </header>

        <div className="messages" aria-live="polite">
          {messages.length === 0 && (
            <div className="empty-thread">
              <span className="empty-thread-mark">{companion.name.slice(0, 1).toUpperCase()}</span>
              <h2>Clean thread</h2>
              <p>
                {activeConversation?.kind === "group"
                  ? "Use @Nox, @Kian, @Oran, or @everyone. Every companion you address gets a turn, and companions can hand off with visible @mentions."
                  : `This conversation starts with ${companion.name}’s active ${
                      companion.identitySource === "file"
                        ? "identity file"
                        : "custom instructions"
                    } and no messages from another chat.`}
              </p>
              <button onClick={() => openStudio("identity")}>Check active identity</button>
            </div>
          )}
          {messages.map((message, index) => (
            <Fragment key={message.id}>
              {(index === 0 ||
                localDayKey(messages[index - 1].createdAt) !==
                  localDayKey(message.createdAt)) && (
                <div className="day-marker">
                  <span>{conversationDayLabel(message.createdAt)}</span>
                </div>
              )}
              <article
              className={`message ${message.role === "user" ? "from-user" : "from-kian"}`}
              style={
                message.role === "assistant"
                  ? ({
                      "--message-bubble": messageCompanion(message).companionBubbleColor,
                      "--message-accent": messageCompanion(message).accent,
                    } as React.CSSProperties)
                  : undefined
              }
            >
              {message.role === "assistant" && (
                <span className="avatar message-avatar">
                  {messageCompanion(message).name.slice(0, 1).toUpperCase()}
                </span>
              )}
              <div className="message-stack">
                <div className="message-meta">
                  <strong>
                    {message.role === "user" ? "You" : messageCompanion(message).name}
                  </strong>
                  {activeConversation?.kind === "group" &&
                    message.role === "assistant" &&
                    message.replyToSpeakerName &&
                    message.replyToSpeakerName !== "Becca" && (
                      <span className="replying-to">
                        replying to {message.replyToSpeakerName}
                      </span>
                    )}
                  {activeConversation?.kind === "group" &&
                    message.role === "assistant" &&
                    Boolean(message.audience?.length) && (
                      <span className="handoff-to">
                        calls {message.audience
                          ?.map((id) => activeConversation.members.find((member) => member.id === id)?.name)
                          .filter(Boolean)
                          .map((name) => `@${name}`)
                          .join(", ")}
                      </span>
                    )}
                  <time
                    dateTime={message.createdAt}
                    title={new Intl.DateTimeFormat("en-US", {
                      timeZone: "America/Chicago",
                      dateStyle: "full",
                      timeStyle: "short",
                    }).format(new Date(message.createdAt))}
                    suppressHydrationWarning
                  >
                    {new Intl.DateTimeFormat("en-US", {
                      timeZone: "America/Chicago",
                      hour: "numeric",
                      minute: "2-digit",
                    }).format(new Date(message.createdAt))}
                  </time>
                  {message.role === "assistant" &&
                    typeof message.costUsd === "number" && (
                      <span
                        className="message-usage"
                        title={[
                          `${(message.inputTokens || 0).toLocaleString()} fresh input`,
                          `${(message.cacheWriteTokens || 0).toLocaleString()} cache write`,
                          `${(message.cacheReadTokens || 0).toLocaleString()} cache read`,
                          `${(message.outputTokens || 0).toLocaleString()} output`,
                          message.costSource || "estimated",
                        ].join(" · ")}
                      >
                        {message.costSource === "estimated" ? "~" : ""}
                        {compactCost(message.costUsd)}
                        <small>
                          {(
                            (message.inputTokens || 0) +
                            (message.cacheWriteTokens || 0) +
                            (message.cacheReadTokens || 0) +
                            (message.outputTokens || 0)
                          ).toLocaleString()}{" "}
                          tok
                        </small>
                      </span>
                    )}
                  {message.status !== "streaming" && Boolean(message.body) && (
                    <button
                      type="button"
                      className="message-action"
                      onClick={() => void copyMessage(message)}
                      aria-label={`Copy ${message.role === "user" ? "your message" : `${messageCompanion(message).name}’s reply`}`}
                    >
                      {copiedMessageId === message.id ? "✓ Copied" : "Copy"}
                    </button>
                  )}
                  {message.role === "user" &&
                    message.status !== "streaming" &&
                    Boolean(message.body) && (
                      <button
                        type="button"
                        className="message-action"
                        onClick={() => beginEditingMessage(message)}
                        disabled={sending}
                      >
                        Edit
                      </button>
                    )}
                  {message.role === "assistant" &&
                    message.status !== "streaming" &&
                    Boolean(message.body) && (
                      <button
                        type="button"
                        className="message-action"
                        onClick={() => void reviseMessage(message, "retry")}
                        disabled={sending}
                      >
                        ↻ Retry
                      </button>
                    )}
                  {message.role === "assistant" &&
                    message.status !== "streaming" &&
                    Boolean(message.body) && (
                      <button
                        type="button"
                        className="read-aloud"
                        data-speaking={speakingMessageId === message.id || undefined}
                        onClick={() => void readAloud(message)}
                        aria-label={
                          speakingMessageId === message.id
                            ? generatingVoiceMessageId === message.id
                              ? `Generating ${messageCompanion(message).name}’s voice`
                              : "Stop reading"
                            : `Read ${messageCompanion(message).name}’s reply aloud`
                        }
                      >
                        {generatingVoiceMessageId === message.id
                          ? "… Voice"
                          : speakingMessageId === message.id
                            ? "■ Stop"
                            : "▶ Read"}
                      </button>
                    )}
                </div>
                <div className="message-body">
                  {Boolean(message.attachments?.length) && (
                    <div className="message-attachments">
                      {message.attachments?.map((attachment) => (
                        <a
                          key={attachment.id}
                          href={attachment.url}
                          target="_blank"
                          rel="noreferrer"
                          data-image={attachment.mediaType.startsWith("image/") || undefined}
                        >
                          {attachment.mediaType.startsWith("image/") ? (
                            <Image
                              src={attachment.url}
                              alt={attachment.name}
                              width={240}
                              height={180}
                              unoptimized
                            />
                          ) : (
                            <span>{attachment.mediaType === "application/pdf" ? "PDF" : "FILE"}</span>
                          )}
                          <small>
                            <strong>{attachment.name}</strong>
                            {formatFileSize(attachment.size)}
                          </small>
                        </a>
                      ))}
                    </div>
                  )}
                  {message.role === "user" &&
                  editingMessageId === message.id ? (
                    <form
                      className="message-editor"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void reviseMessage(message, "edit");
                      }}
                    >
                      <textarea
                        value={editingMessageDraft}
                        onChange={(event) =>
                          setEditingMessageDraft(event.target.value)
                        }
                        rows={Math.min(
                          10,
                          Math.max(
                            3,
                            editingMessageDraft.split("\n").length,
                          ),
                        )}
                        autoFocus
                      />
                      <div>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingMessageId(null);
                            setEditingMessageDraft("");
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={!editingMessageDraft.trim() || sending}
                        >
                          Save and retry
                        </button>
                      </div>
                    </form>
                  ) : message.status === "streaming" && !message.body ? (
                    <span
                      className="typing-dots"
                      aria-label={`${messageCompanion(message).name} is writing`}
                    >
                      <i /><i /><i />
                    </span>
                  ) : message.body ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body}</ReactMarkdown>
                  ) : null}
                </div>
              </div>
              </article>
            </Fragment>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div className="composer-wrap">
          {notice && !studioTab && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss notice">×</button></div>}
          {activeConversation?.kind === "group" && groupTurn && (
            <div className="group-activity" aria-live="polite">
              <strong>Group activity</strong>
              <div>
                {groupTurn.members.map((member) => (
                  <span
                    key={member.id}
                    data-status={member.status}
                    title={member.error}
                  >
                    <i aria-hidden="true" />
                    {member.name}
                    <small>
                      {member.status === "queued"
                        ? "waiting"
                        : member.status === "responding"
                          ? "responding"
                          : member.status === "complete"
                            ? "replied"
                            : "failed"}
                    </small>
                  </span>
                ))}
              </div>
            </div>
          )}
          {activeConversation?.kind === "group" && (
            <div className="speaker-picker">
              <span>Mention</span>
              <div>
                {activeConversation.members.map((member) => (
                  <button
                    type="button"
                    key={member.id}
                    data-active={
                      composerAudienceIds.includes(member.id) || undefined
                    }
                    onClick={() => {
                      setGroupSpeakerId(member.id);
                      const selected = companions.find((item) => item.id === member.id);
                      if (selected) setCompanion(selected);
                      insertGroupMention(member.name);
                    }}
                  >
                    <i style={{ background: member.accent }}>
                      {member.name.slice(0, 1).toUpperCase()}
                    </i>
                    {member.name}
                  </button>
                ))}
                <button
                  type="button"
                  data-active={composerMentionsEveryone || undefined}
                  onClick={() => insertGroupMention("everyone")}
                >
                  <i>＠</i>
                  Everyone
                </button>
              </div>
            </div>
          )}
          {Boolean(pendingAttachments.length) && (
            <div className="pending-attachments">
              {pendingAttachments.map((attachment) => (
                <div key={attachment.id}>
                  {attachment.mediaType.startsWith("image/") ? (
                    <Image
                      src={attachment.url}
                      alt=""
                      width={42}
                      height={42}
                      unoptimized
                    />
                  ) : (
                    <span>{attachment.mediaType === "application/pdf" ? "PDF" : "TXT"}</span>
                  )}
                  <p><strong>{attachment.name}</strong><small>{formatFileSize(attachment.size)}</small></p>
                  <button
                    type="button"
                    onClick={() => void removePendingAttachment(attachment)}
                    aria-label={`Remove ${attachment.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <form className="composer" onSubmit={submitMessage}>
            <input
              ref={attachmentInputRef}
              className="attachment-input"
              type="file"
              multiple
              accept=".jpg,.jpeg,.png,.webp,.gif,.pdf,.txt,.md,.csv,.json,.html,.xml,image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/csv,application/json,text/html,application/xml,text/xml"
              onChange={(event) => void attachFiles(event.target.files)}
            />
            <button
              type="button"
              className="attach"
              aria-label="Attach files"
              disabled={uploadingAttachments || sending || pendingAttachments.length >= 4}
              onClick={() => attachmentInputRef.current?.click()}
            >
              <Icon size={24}><svg viewBox="0 0 24 24"><path d="m20 12-8.2 8.2a5 5 0 0 1-7.1-7.1L14 3.8a3.5 3.5 0 0 1 5 5l-9.3 9.3a2 2 0 0 1-2.8-2.8L15 7.2" /></svg></Icon>
            </button>
            <label>
              <span className="sr-only">Message {companion.name}</span>
              <textarea
                ref={composerTextareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={
                  activeConversation?.kind === "group"
                    ? `Message the group · use @names or @everyone…`
                    : `Message ${companion.name}…`
                }
                rows={1}
              />
              <small>Enter for a new line · tap the arrow to send</small>
            </label>
            <button
              type="button"
              className="voice-mode-toggle"
              data-on={voiceMode || undefined}
              aria-pressed={voiceMode}
              aria-label={
                voiceMode
                  ? "Turn off voice mode (replies read aloud)"
                  : "Turn on voice mode (read every reply aloud)"
              }
              title={
                voiceMode
                  ? "Voice mode on — every reply is read aloud"
                  : "Voice mode — read every reply aloud"
              }
              onClick={() => {
                const next = !voiceMode;
                setVoiceMode(next);
                window.localStorage.setItem(
                  VOICE_MODE_STORAGE,
                  next ? "on" : "off",
                );
                if (!next) {
                  activeAudioRef.current?.pause();
                  setSpeakingMessageId(null);
                } else {
                  // Only read replies that land from here on.
                  for (const item of messages) spokenMessageIdsRef.current.add(item.id);
                }
              }}
            >
              <Icon size={23}>
                <svg viewBox="0 0 24 24">
                  <path d="M11 5 6 9H3v6h3l5 4z" />
                  {voiceMode ? (
                    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
                  ) : (
                    <path d="M16 9l5 6M21 9l-5 6" />
                  )}
                </svg>
              </Icon>
            </button>
            <button
              type="button"
              className="dictate"
              data-listening={listening || undefined}
              aria-label={listening ? "Stop talk-to-text" : "Start talk-to-text"}
              title={listening ? "Stop listening" : "Talk to text"}
              onClick={toggleDictation}
              disabled={sending}
            >
              <Icon size={23}>
                <svg viewBox="0 0 24 24">
                  <rect x="9" y="3" width="6" height="11" rx="3" />
                  <path d="M5.5 10.5a6.5 6.5 0 0 0 13 0M12 17v4M9 21h6" />
                </svg>
              </Icon>
            </button>
            <button
              className="send"
              aria-label="Send message"
              disabled={(!draft.trim() && !pendingAttachments.length) || sending || uploadingAttachments}
            >
              <Icon size={24}><svg viewBox="0 0 24 24"><path d="m4 4 17 8-17 8 3-8-3-8Z" /><path d="M7 12h14" /></svg></Icon>
            </button>
          </form>
          <p className="prototype-note">
            {providerConnected(companion.provider)
              ? `${providerInfo[companion.provider].name} connected · ${modelLabel(companion, modelCatalogs)}`
              : `Private prototype · ${providerInfo[companion.provider].name} key not connected`}
          </p>
        </div>
      </section>

      {pendingConversationAction && (
        <div className="studio-layer confirmation-layer" role="presentation">
          <button
            className="studio-backdrop"
            onClick={() => {
              if (!runningConversationAction) setPendingConversationAction(null);
            }}
            aria-label="Cancel conversation action"
          />
          <section
            className="conversation-confirmation"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="conversation-confirmation-title"
            aria-describedby="conversation-confirmation-description"
          >
            <span className="confirmation-kicker">
              {pendingConversationAction.action === "delete"
                ? "Permanent deletion"
                : "Move conversation"}
            </span>
            <h2 id="conversation-confirmation-title">
              {pendingConversationAction.action === "delete"
                ? `Delete “${pendingConversationAction.conversation.title}”?`
                : `Archive “${pendingConversationAction.conversation.title}”?`}
            </h2>
            <p id="conversation-confirmation-description">
              {pendingConversationAction.action === "delete"
                ? "Its messages and attachments will be permanently removed. This cannot be undone."
                : "It will leave your active chat list, but nothing will be deleted. You can restore it from Archived chats."}
            </p>
            <footer>
              <button
                type="button"
                className="confirmation-cancel"
                disabled={runningConversationAction}
                onClick={() => setPendingConversationAction(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={
                  pendingConversationAction.action === "delete"
                    ? "confirmation-submit danger"
                    : "confirmation-submit"
                }
                disabled={runningConversationAction}
                onClick={() => {
                  if (pendingConversationAction.action === "delete") {
                    void permanentlyDeleteConversation(
                      pendingConversationAction.conversation,
                    );
                  } else {
                    void updateConversationArchived(
                      pendingConversationAction.conversation,
                    );
                  }
                }}
              >
                {runningConversationAction
                  ? "Working…"
                  : pendingConversationAction.action === "delete"
                    ? "Delete permanently"
                    : "Archive chat"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {chatCreator && (
        <div className="studio-layer room-creator-layer" role="presentation">
          <button
            className="studio-backdrop"
            onClick={() => setChatCreator(null)}
            aria-label="Close room creator"
          />
          <section
            className="room-creator"
            role="dialog"
            aria-modal="true"
            aria-label={chatCreator === "group" ? "Create group chat" : "Create chat"}
          >
            <header>
              <div>
                <span>{chatCreator === "group" ? "Group room" : "Solo room"}</span>
                <h2>
                  {chatCreator === "group"
                    ? "Who’s entering the room?"
                    : "Who are you talking to?"}
                </h2>
              </div>
              <button onClick={() => setChatCreator(null)} aria-label="Close">×</button>
            </header>
            <label>
              <span>Chat name <small>optional</small></span>
              <input
                value={newChatTitle}
                onChange={(event) => setNewChatTitle(event.target.value)}
                placeholder={
                  chatCreator === "group" ? "The kitchen table, Chaos committee…" : "New chat"
                }
              />
            </label>
            <div className="room-kind-switch" role="tablist" aria-label="Room type">
              <button
                type="button"
                data-active={chatCreator === "solo" || undefined}
                onClick={() => {
                  setChatCreator("solo");
                  setNewChatCompanionIds([newChatCompanionIds[0] || companion.id]);
                }}
              >
                Solo
              </button>
              <button
                type="button"
                data-active={chatCreator === "group" || undefined}
                onClick={() => {
                  setChatCreator("group");
                  setNewChatCompanionIds(
                    Array.from(
                      new Set([
                        newChatCompanionIds[0] || companion.id,
                        ...companions.slice(0, 2).map((item) => item.id),
                      ]),
                    ),
                  );
                }}
              >
                Group
              </button>
            </div>
            <div className="room-companion-list">
              {companions.map((item) => {
                const selected = newChatCompanionIds.includes(item.id);
                return (
                  <button
                    type="button"
                    key={item.id}
                    data-selected={selected || undefined}
                    onClick={() => {
                      if (chatCreator === "solo") {
                        setNewChatCompanionIds([item.id]);
                        return;
                      }
                      setNewChatCompanionIds((current) =>
                        selected
                          ? current.filter((id) => id !== item.id)
                          : [...current, item.id],
                      );
                    }}
                  >
                    <span
                      className="avatar"
                      style={{ "--avatar-color": item.accent } as React.CSSProperties}
                    >
                      {item.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.tagline || modelLabel(item, modelCatalogs)}</small>
                    </span>
                    <i>{selected ? "✓" : "+"}</i>
                  </button>
                );
              })}
            </div>
            {chatCreator === "group" && companions.length < 2 && (
              <button
                className="creator-add-companion"
                type="button"
                onClick={() => {
                  setChatCreator(null);
                  openStudio("companions");
                }}
              >
                Add another companion first
              </button>
            )}
            <footer>
              <span>
                {newChatCompanionIds.length}{" "}
                {newChatCompanionIds.length === 1 ? "companion" : "companions"} selected
              </span>
              <button
                type="button"
                onClick={() => void createConversation()}
                disabled={
                  creatingConversation ||
                  (chatCreator === "group" && newChatCompanionIds.length < 2) ||
                  !newChatCompanionIds.length
                }
              >
                {creatingConversation ? "Opening…" : "Create room"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {studioTab && (
        <div className="studio-layer" role="presentation">
          <button className="studio-backdrop" onClick={() => setStudioTab(null)} aria-label={`Close ${studioSurface === "lab" ? "Companion Lab" : studioSurface === "memory" ? "Memory" : "Settings"}`} />
          <section className="studio-panel" role="dialog" aria-modal="true" aria-label={studioSurface === "lab" ? "Companion Lab" : studioSurface === "memory" ? "Memory" : "Settings"}>
            <header className="studio-header">
              <div>
                <span>{studioSurface === "lab" ? "Companion Lab" : studioSurface === "memory" ? "Memory" : "Settings"}</span>
                <h2>
                  {studioSurface === "lab"
                    ? studioTab === "companions"
                      ? "Distinct identities"
                      : editing.name || "Companion"
                    : studioSurface === "memory"
                      ? "Continuity room"
                      : studioTab === "provider"
                        ? "Models and providers"
                      : studioTab === "budget"
                        ? "Usage and spending"
                        : studioTab === "connectors"
                          ? "Tools and connectors"
                          : studioTab === "archive"
                            ? "Archived conversations"
                          : "Voice"}
                </h2>
                <p>
                  {studioSurface === "lab"
                    ? studioTab === "companions"
                      ? "Create and maintain the people who live here."
                      : creatingCompanion
                        ? "Build the identity here, then save the new companion."
                        : "Changes save as a new identity version."
                    : studioSurface === "memory"
                      ? "Review exactly what the house remembers and who can retrieve it."
                      : "App-wide connections, model defaults, spending, and voice."}
                </p>
              </div>
              <button onClick={() => setStudioTab(null)} aria-label="Close panel">×</button>
            </header>

            {studioSurface !== "memory" && (
            <nav className="studio-tabs" aria-label={studioSurface === "lab" ? "Companion Lab" : "Settings"}>
              {(studioSurface === "lab"
                ? (["companions", "identity"] as StudioTab[])
                : (["provider", "voice", "connectors", "budget", "archive"] as StudioTab[])
              ).map((tab) => (
                <button key={tab} data-active={studioTab === tab || undefined} onClick={() => setStudioTab(tab)}>
                  {tab === "companions"
                    ? "Companions"
                    : tab === "identity"
                      ? "Identity"
                      : tab === "provider"
                        ? "Keys & models"
                        : tab === "budget"
                          ? "Spending"
                          : tab === "connectors"
                            ? "Tools"
                            : tab === "archive"
                              ? "Archived chats"
                          : tab === "voice"
                            ? "Voice"
                            : "Memory"}
                </button>
              ))}
            </nav>
            )}

            {notice && (
              <div className="studio-notice" role="status">
                <span>{notice}</span>
                <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notice">×</button>
              </div>
            )}

            <div className="studio-body">
              {studioSurface === "settings" && studioTab !== "budget" && studioTab !== "connectors" && studioTab !== "archive" && (
                <label className="settings-companion-picker">
                  <span>Configure companion</span>
                  <select
                    value={editing.id}
                    onChange={(event) => {
                      const next =
                        companions.find((item) => item.id === event.target.value) || companion;
                      setEditing(next);
                      setKeyDraft("");
                      setShowKey(false);
                      if (studioTab === "provider") void refreshProviderModels(next.provider);
                    }}
                  >
                    {companions.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                  <small>Provider defaults and voice choices belong to this companion. A chat can still override its model from the header dropdown.</small>
                </label>
              )}

              {studioTab === "companions" && (
                <div className="settings-section companion-manager">
                  <div className="section-intro">
                    <h3>Companion roster</h3>
                    <p>Create separate identities, then place any combination of them into group rooms.</p>
                  </div>
                  <div className="companion-grid">
                    {companions.map((item) => (
                      <article key={item.id}>
                        <div className="companion-card-top">
                          <span
                            className="avatar"
                            style={{ "--avatar-color": item.accent } as React.CSSProperties}
                          >
                            {item.name.slice(0, 1).toUpperCase()}
                          </span>
                          <div>
                            <strong>{item.name}</strong>
                            <small>{item.tagline || "No description yet"}</small>
                          </div>
                        </div>
                        <dl>
                          <div><dt>Identity</dt><dd>{item.identitySource === "file" ? "Identity file" : "Custom instructions"}</dd></div>
                          <div><dt>Version</dt><dd>{item.version}</dd></div>
                        </dl>
                        <div className="companion-card-actions">
                          <button type="button" onClick={() => editCompanionProfile(item)}>
                            Edit companion
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setStudioTab(null);
                              openChatCreator("solo", item.id);
                            }}
                          >
                            New chat
                          </button>
                        </div>
                      </article>
                    ))}
                    <button type="button" className="add-companion-card" onClick={beginNewCompanion}>
                      <span>+</span>
                      <strong>Add companion</strong>
                      <small>Upload another identity file or write new instructions.</small>
                    </button>
                  </div>
                </div>
              )}

              {studioTab === "identity" && (
                <div className="settings-section">
                  <div className="section-intro"><h3>Identity</h3><p>Choose one source. Companion Lab sends only the active source with each message.</p></div>
                  <label><span>Name</span><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
                  <label><span>Short description</span><input value={editing.tagline} onChange={(e) => setEditing({ ...editing, tagline: e.target.value })} /></label>
                  <div className="bubble-colors">
                    <div className="bubble-colors-heading">
                      <div><span>Message colors</span><small>Only the bubbles change. Purple has been formally reinstated.</small></div>
                      <div className="bubble-preview" aria-label="Bubble color preview">
                        <i style={{ background: editing.companionBubbleColor }}>K</i>
                        <i style={{ background: editing.userBubbleColor }}>B</i>
                      </div>
                    </div>
                    {([
                      ["Companion bubbles", "companionBubbleColor"],
                      ["Your bubbles", "userBubbleColor"],
                    ] as const).map(([label, field]) => (
                      <div className="bubble-color-row" key={field}>
                        <span>{label}</span>
                        <div className="color-swatches">
                          {bubblePresets.map((preset) => (
                            <button
                              type="button"
                              key={preset.value}
                              title={preset.name}
                              aria-label={`${label}: ${preset.name}`}
                              aria-pressed={editing[field] === preset.value}
                              data-active={editing[field] === preset.value || undefined}
                              style={{ "--swatch": preset.value } as React.CSSProperties}
                              onClick={() => setEditing({ ...editing, [field]: preset.value })}
                            />
                          ))}
                          <label className="custom-color" title={`Custom ${label.toLowerCase()}`}>
                            <input
                              type="color"
                              value={editing[field]}
                              onChange={(event) => setEditing({ ...editing, [field]: event.target.value })}
                            />
                            <span>+</span>
                          </label>
                          <code>{editing[field]}</code>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="identity-source" role="radiogroup" aria-label="Identity source">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={editing.identitySource === "custom"}
                      data-active={editing.identitySource === "custom" || undefined}
                      onClick={() => setEditing({ ...editing, identitySource: "custom" })}
                    >
                      <span className="source-radio" aria-hidden="true" />
                      <span><strong>Custom instructions</strong><small>Write the instruction block directly in the app.</small></span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={editing.identitySource === "file"}
                      data-active={editing.identitySource === "file" || undefined}
                      onClick={() => setEditing({ ...editing, identitySource: "file" })}
                    >
                      <span className="source-radio" aria-hidden="true" />
                      <span><strong>Identity file</strong><small>Use a saved Markdown or text file.</small></span>
                    </button>
                  </div>

                  {editing.identitySource === "custom" ? (
                    <label>
                      <span>Custom instructions</span>
                      <textarea
                        className="identity-editor"
                        rows={14}
                        value={editing.customInstructions}
                        onChange={(e) => setEditing({ ...editing, customInstructions: e.target.value })}
                        placeholder={`Write instructions for ${editing.name || "this companion"}…`}
                      />
                      <small>{editing.customInstructions.length.toLocaleString()} characters</small>
                    </label>
                  ) : (
                    <>
                      <label className="file-upload">
                        <input
                          type="file"
                          accept=".md,.txt,.zip,text/markdown,text/plain,application/zip"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void loadIdentityFile(file);
                            event.currentTarget.value = "";
                          }}
                        />
                        <span className="upload-icon">↥</span>
                        <span>
                          <strong>{editing.identityFileName || "Upload identity file"}</strong>
                          <small>
                            {editing.identityFileName
                              ? `${editing.identityFileContent.length.toLocaleString()} characters · choose another file to replace it`
                              : "Markdown, plain text, or .skill.zip · extracted text up to 200 KB"}
                          </small>
                        </span>
                      </label>
                      <label>
                        <span>Identity file contents</span>
                        <textarea
                          className="identity-editor"
                          rows={14}
                          value={editing.identityFileContent}
                          onChange={(e) => setEditing({ ...editing, identityFileContent: e.target.value })}
                          placeholder="Upload an identity file or write one here…"
                        />
                        <small>Saved as {editing.identityFileName || `${editing.name || "companion"}-identity.md`}</small>
                      </label>
                    </>
                  )}
                </div>
              )}

              {studioTab === "provider" && (
                <div className="settings-section">
                  <div className="section-intro"><h3>Provider and model</h3><p>The identity stays the same when you switch engines. Each model will still interpret it differently.</p></div>
                  <div className="provider-list">
                    {(Object.keys(providerInfo) as Companion["provider"][]).map((provider) => (
                      <button
                        key={provider}
                        className="provider-card"
                        data-active={editing.provider === provider || undefined}
                        onClick={() => {
                          const firstModel = modelCatalogs[provider][0] || providerModels[provider][0];
                          setEditing({ ...editing, provider, model: firstModel.id });
                          setKeyDraft("");
                          setShowKey(false);
                          void refreshProviderModels(provider);
                        }}
                      >
                        <span className="provider-mark">{providerInfo[provider].name.slice(0, 1)}</span>
                        <span><strong>{providerInfo[provider].name}</strong><small>{providerInfo[provider].detail}</small></span>
                        <i data-connected={providerConnected(provider) || undefined}>{providerConnected(provider) ? "Connected" : "No key"}</i>
                      </button>
                    ))}
                  </div>
                  <div className="model-picker-heading">
                    <div><strong>Model</strong><small>{loadingModels ? "Checking the provider…" : `${displayedModels.length} conversational choices`}</small></div>
                    <button type="button" onClick={() => void refreshProviderModels(editing.provider)} disabled={loadingModels}>
                      {loadingModels ? "Loading…" : "Refresh list"}
                    </button>
                  </div>
                  <select className="model-select" aria-label="Model" value={editing.model} onChange={(e) => setEditing({ ...editing, model: e.target.value })}>
                    {displayedModels.map((model) => <option key={model.id} value={model.id}>{modelOptionLabel(model)}</option>)}
                  </select>
                  <label>
                    <span>Custom model ID</span>
                    <input
                      value={editing.model}
                      onChange={(event) => setEditing({ ...editing, model: event.target.value })}
                      placeholder="Paste an exact provider model ID"
                    />
                    <small>The refreshed list follows what your account can access. This field keeps future models usable without waiting for an app update.</small>
                  </label>
                  <div className="secret-card">
                    <div>
                      <span className="secret-icon">⌁</span>
                      <span>
                        <strong>{providerInfo[editing.provider].name} API key</strong>
                        <small>
                          {providerConnected(editing.provider)
                            ? secrets[editing.provider]
                              ? "Connected through protected server settings"
                              : "Remembered in this app on this device"
                            : "Not connected"}
                        </small>
                      </span>
                    </div>
                    <div className="key-entry">
                      <input
                        type={showKey ? "text" : "password"}
                        value={keyDraft}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setKeyDraft(event.target.value)}
                        placeholder={providerConnected(editing.provider) ? "Enter a replacement key" : "Paste API key"}
                        aria-label={`${providerInfo[editing.provider].name} API key`}
                      />
                      <button type="button" className="show-key" onClick={() => setShowKey((visible) => !visible)}>
                        {showKey ? "Hide" : "Show"}
                      </button>
                      <button type="button" className="save-key" onClick={() => void saveDeviceKey()} disabled={!keyDraft.trim()}>
                        Save on device
                      </button>
                    </div>
                    {deviceKeys[editing.provider] && (
                      <button type="button" className="remove-key" onClick={() => removeDeviceKey(editing.provider)}>
                        Remove key from this device
                      </button>
                    )}
                    <p>The key stays in private storage on this device and travels over HTTPS only for provider requests. It is never written into a companion profile, identity, or conversation history.</p>
                  </div>
                  <label><span>Group autonomy</span><select value={editing.autonomy} onChange={(e) => setEditing({ ...editing, autonomy: e.target.value as Companion["autonomy"] })}>
                    <option value="manual">Manual · you choose every speaker</option>
                    <option value="selected">Selected · chosen companions may answer</option>
                    <option value="handoff">Handoff · a companion can invite the next speaker</option>
                  </select></label>
                </div>
              )}

              {studioTab === "budget" && (
                <div className="settings-section">
                  <div className="section-intro">
                    <h3>API spending</h3>
                    <p>Every completed reply records tokens and cost. OpenRouter reports the charge directly; Anthropic and OpenAI are estimated from the model’s published token price unless you connect an admin key below, which replaces the estimate with what the provider actually billed.</p>
                  </div>
                  <div className="budget-hero usage-hero">
                    <span>Spent this month</span>
                    <strong>${usage.totalCost.toFixed(4)}</strong>
                    <small>${usage.remaining.toFixed(2)} left from a ${usage.monthlyBudget.toFixed(2)} app budget</small>
                    <div className="usage-track"><i style={{ width: `${usage.percent}%` }} /></div>
                    <div className="usage-hero-stats">
                      <span><b>{usage.messages}</b> API runs</span>
                      <span><b>{usage.inputTokens.toLocaleString()}</b> input tokens</span>
                      <span><b>{usage.outputTokens.toLocaleString()}</b> output tokens</span>
                      <span><b>{usage.cacheWriteTokens.toLocaleString()}</b> cache writes</span>
                      <span><b>{usage.cacheReadTokens.toLocaleString()}</b> cache reads</span>
                    </div>
                  </div>
                  <label>
                    <span>Workspace monthly budget</span>
                    <div className="money-input">
                      <b>$</b>
                      <input
                        type="number"
                        min="0.01"
                        max="10000"
                        step="0.50"
                        value={editingMonthlyBudget}
                        onChange={(event) => setEditingMonthlyBudget(Number(event.target.value))}
                      />
                    </div>
                    <small>This controls Companion Lab’s “remaining” meter. Keep the provider’s own hard spending limit enabled too.</small>
                  </label>
                  <section className="account-balance-tracker">
                    <div className="account-balance-heading">
                      <div>
                        <h4>Provider credit tracking</h4>
                        <p>Live provider data appears where the provider exposes it. Manual anchors automatically subtract every later run Companion Lab records.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          void refreshUsage();
                          void refreshOpenRouterCredits(true);
                        }}
                        disabled={syncingProviderCredits}
                      >
                        {syncingProviderCredits ? "Syncing…" : "Sync now"}
                      </button>
                    </div>
                    <div className="account-balance-grid">
                      {(["openai", "anthropic", "openrouter"] as Companion["provider"][]).map((provider) => {
                        const manualRemaining = providerBalance(provider);
                        const anchor = providerFunds[provider];
                        const spentAfterAnchor = anchor
                          ? Math.max(0, lifetimeProviderCost(provider) - anchor.trackedCost)
                          : 0;
                        const liveRemaining =
                          provider === "openrouter"
                            ? openRouterCredits?.account?.remaining ??
                              openRouterCredits?.key?.limitRemaining ??
                              null
                            : null;
                        const remaining = liveRemaining ?? manualRemaining;
                        const spentInfo = spentSinceAnchor(provider);
                        const trackingMode =
                          provider === "openrouter" &&
                          openRouterCredits?.account
                            ? "Live account"
                            : provider === "openrouter" &&
                                openRouterCredits?.key?.limitRemaining !== null &&
                                openRouterCredits?.key?.limitRemaining !== undefined
                              ? "Live key limit"
                              : spentInfo.reported
                                ? "Real spend"
                                : "Local estimate";
                        return (
                          <article key={provider}>
                            <div>
                              <div className="account-balance-label">
                                <span>{providerInfo[provider].name}</span>
                                <i data-live={trackingMode.startsWith("Live") || undefined}>
                                  {trackingMode}
                                </i>
                              </div>
                              <strong>{remaining === null ? "Set balance" : `$${remaining.toFixed(4)}`}</strong>
                              <small>
                                {provider === "openrouter" && openRouterCredits?.account
                                  ? `$${openRouterCredits.account.totalUsage.toFixed(4)} used from $${openRouterCredits.account.totalCredits.toFixed(4)} purchased`
                                  : provider === "openrouter" && openRouterCredits?.key
                                    ? `$${openRouterCredits.key.usageMonthly.toFixed(4)} used by this key this month`
                                    : anchor
                                      ? `$${spentAfterAnchor.toFixed(4)} spent here since ${new Date(anchor.savedAt).toLocaleDateString()}`
                                      : "Waiting for a starting balance"}
                              </small>
                            </div>
                            <div className="account-balance-entry">
                              <span>$</span>
                              <input
                                type="number"
                                min="0"
                                max="100000"
                                step="0.01"
                                inputMode="decimal"
                                value={providerFundDrafts[provider] || ""}
                                onChange={(event) =>
                                  setProviderFundDrafts({
                                    ...providerFundDrafts,
                                    [provider]: event.target.value,
                                  })
                                }
                                placeholder="Current balance"
                                aria-label={`${providerInfo[provider].name} starting balance`}
                              />
                              <button type="button" onClick={() => saveProviderFund(provider)}>
                                {anchor ? "Reset local anchor" : "Start local estimate"}
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                    <div className="secret-card provider-credit-key-card">
                      <div>
                        <span className="secret-icon">↻</span>
                        <span>
                          <strong>OpenRouter live account credits</strong>
                          <small>
                            {openRouterManagementKey
                              ? openRouterCredits?.account
                                ? `Live · last synced ${new Date(openRouterCredits.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                                : "Management key saved · waiting for a successful sync"
                              : openRouterCredits?.key
                                ? "Chat-key usage is live · add a management key for the full account balance"
                                : "Add a management key for purchased, used, and remaining account credits"}
                          </small>
                        </span>
                      </div>
                      <div className="key-entry">
                        <input
                          type={showOpenRouterManagementKey ? "text" : "password"}
                          value={openRouterManagementKeyDraft}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(event) =>
                            setOpenRouterManagementKeyDraft(event.target.value)
                          }
                          placeholder={
                            openRouterManagementKey
                              ? "Enter a replacement management key"
                              : "Paste OpenRouter management key"
                          }
                          aria-label="OpenRouter management key"
                        />
                        <button
                          type="button"
                          className="show-key"
                          onClick={() =>
                            setShowOpenRouterManagementKey((visible) => !visible)
                          }
                        >
                          {showOpenRouterManagementKey ? "Hide" : "Show"}
                        </button>
                        <button
                          type="button"
                          className="save-key"
                          onClick={saveOpenRouterManagementKey}
                          disabled={!openRouterManagementKeyDraft.trim()}
                        >
                          Save on device
                        </button>
                      </div>
                      {openRouterManagementKey && (
                        <button
                          type="button"
                          className="remove-key"
                          onClick={removeOpenRouterManagementKey}
                        >
                          Remove management key from this device
                        </button>
                      )}
                      {openRouterCreditError && (
                        <p className="provider-credit-error">{openRouterCreditError}</p>
                      )}
                      <p>The management key stays in this device’s private storage and travels over HTTPS only for credit checks. OpenRouter does not allow management keys to run chat completions.</p>
                    </div>
                    {(["anthropic", "openai"] as Companion["provider"][]).map((provider) => {
                      const reported = providerSpend[provider];
                      return (
                        <div className="secret-card provider-credit-key-card" key={provider}>
                          <div>
                            <span className="secret-icon">$</span>
                            <span>
                              <strong>{providerInfo[provider].name} real charged spend</strong>
                              <small>
                                {reported
                                  ? `Provider-reported · $${reported.spend.toFixed(4)} charged since ${new Date(reported.since).toLocaleDateString()}`
                                  : adminKeys[provider]
                                    ? "Admin key saved · waiting for a successful read"
                                    : "Add an admin key to replace this app’s estimate with what you were actually billed"}
                              </small>
                            </span>
                          </div>
                          <div className="key-entry">
                            <input
                              type="password"
                              value={adminKeyDrafts[provider] || ""}
                              autoComplete="off"
                              spellCheck={false}
                              onChange={(event) =>
                                setAdminKeyDrafts({
                                  ...adminKeyDrafts,
                                  [provider]: event.target.value,
                                })
                              }
                              placeholder={
                                adminKeys[provider]
                                  ? "Enter a replacement admin key"
                                  : provider === "anthropic"
                                    ? "Paste Anthropic admin key (sk-ant-admin…)"
                                    : "Paste OpenAI admin key (sk-admin…)"
                              }
                              aria-label={`${providerInfo[provider].name} admin key`}
                            />
                            <button
                              type="button"
                              className="save-key"
                              onClick={() => saveAdminKey(provider)}
                              disabled={!(adminKeyDrafts[provider] || "").trim()}
                            >
                              Save on device
                            </button>
                          </div>
                          {adminKeys[provider] && (
                            <button
                              type="button"
                              className="remove-key"
                              onClick={() => removeAdminKey(provider)}
                            >
                              Remove admin key from this device
                            </button>
                          )}
                          {providerSpendErrors[provider] && (
                            <p className="provider-credit-error">
                              {providerSpendErrors[provider]}
                            </p>
                          )}
                          <p>
                            {provider === "anthropic"
                              ? "Create this in the Anthropic Console under Admin keys — it is separate from your chat key and only an organization owner can make one."
                              : "Create this in the OpenAI platform settings under Admin keys — it is separate from your chat key."}{" "}
                            It stays in this device’s private storage and is used only to read your spend.
                          </p>
                        </div>
                      );
                    })}
                    <small>
                      Anthropic and OpenAI publish what you were <b>charged</b>, but neither publishes a
                      remaining prepaid balance — no app can show one. With an admin key connected, the
                      amount spent is the provider’s own figure and the remaining number is your entered
                      balance minus that real spend. Without one, both numbers are this app’s estimate.
                    </small>
                  </section>
                  <section className="model-price-guide">
                    <div>
                      <h4>Claude 4.5 price gauge</h4>
                      <a
                        href="https://platform.claude.com/docs/en/about-claude/pricing"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Anthropic pricing
                      </a>
                    </div>
                    <div className="model-price-grid">
                      <article>
                        <span>Sonnet 4.5</span>
                        <strong>$3 input · $15 output</strong>
                        <small>per million tokens · cache reads $0.30</small>
                      </article>
                      <article>
                        <span>Opus 4.5</span>
                        <strong>$5 input · $25 output</strong>
                        <small>per million tokens · about 1.67× Sonnet</small>
                      </article>
                    </div>
                    <p>Identity files, memory, attachments, and conversation history are input. Longer threads cost more because more context travels with each reply. The identity cache is counted separately when Anthropic reports it.</p>
                  </section>
                  <div className="usage-breakdowns">
                    <section>
                      <h4>By companion</h4>
                      {usage.byCompanion.map((item) => (
                        <div key={item.id}>
                          <span>{item.name}<small>{item.messages} API runs</small></span>
                          <strong>${item.cost.toFixed(4)}</strong>
                        </div>
                      ))}
                      {!usage.byCompanion.length && <p>No billed replies this month.</p>}
                    </section>
                    <section>
                      <h4>By provider</h4>
                      {usage.byProvider.map((item) => (
                        <div key={item.provider}>
                          <span>{providerInfo[item.provider as Companion["provider"]]?.name || item.provider}<small>{item.messages} API runs</small></span>
                          <strong>${item.cost.toFixed(4)}</strong>
                        </div>
                      ))}
                      {!usage.byProvider.length && <p>No provider usage recorded yet.</p>}
                    </section>
                    <section className="model-usage-section">
                      <h4>By model</h4>
                      {usage.byModel.map((item) => (
                        <div key={`${item.provider}:${item.model}`}>
                          <span>
                            {item.model}
                            <small>
                              {item.messages} API runs ·{" "}
                              {(
                                item.inputTokens +
                                item.outputTokens +
                                item.cacheWriteTokens +
                                item.cacheReadTokens
                              ).toLocaleString()}{" "}
                              tokens
                            </small>
                          </span>
                          <strong>{compactCost(item.cost)}</strong>
                        </div>
                      ))}
                      {!usage.byModel.length && <p>No model usage recorded yet.</p>}
                    </section>
                  </div>
                  <section className="recent-usage">
                    <div>
                      <h4>Recent API activity</h4>
                      <button
                        type="button"
                        onClick={() => {
                          void refreshUsage();
                          void refreshOpenRouterCredits();
                        }}
                      >
                        Refresh
                      </button>
                    </div>
                    {usage.recent.slice(0, 8).map((item) => (
                      <article key={item.id}>
                        <span><strong>{item.companionName}</strong><small>{item.activityType === "memory" ? "memory" : "chat"} · {item.model} · {item.source}</small></span>
                        <span>
                          <b>{compactCost(item.cost)}</b>
                          <small>
                            {(
                              item.inputTokens +
                              item.outputTokens +
                              item.cacheWriteTokens +
                              item.cacheReadTokens
                            ).toLocaleString()}{" "}
                            tokens
                          </small>
                        </span>
                      </article>
                    ))}
                    {!usage.recent.length && <p>The meter starts counting after the first completed API run.</p>}
                  </section>
                </div>
              )}

              {studioTab === "connectors" && (
                <div className="settings-section">
                  <div className="section-intro">
                    <h3>On-demand tools</h3>
                    <p>Enabled tools are offered to the active model. The model decides when to call them; they do not run or consume search credits on ordinary conversation turns.</p>
                  </div>
                  <section className="continuity-card notion-card">
                    <div className="continuity-card-heading">
                      <div>
                        <strong>Web search</strong>
                        <p>Current web information with provider citations. Available to OpenAI, Anthropic, and OpenRouter models that support their provider’s search tool.</p>
                      </div>
                      <span className="memory-state" data-connected={webSearchEnabled || undefined}>
                        {webSearchEnabled ? "Enabled" : "Off"}
                      </span>
                    </div>
                    <label className="connector-toggle">
                      <input
                        type="checkbox"
                        checked={webSearchEnabled}
                        onChange={(event) => {
                          const enabled = event.target.checked;
                          setWebSearchEnabled(enabled);
                          window.localStorage.setItem(WEB_SEARCH_STORAGE, enabled ? "enabled" : "disabled");
                        }}
                      />
                      <span>Let companions search when the conversation requires current information</span>
                    </label>
                    <small>Search use is capped per reply. Sources are appended as clickable links when the provider returns citation metadata.</small>
                  </section>
                  <section className="continuity-card notion-card">
                    <div className="continuity-card-heading">
                      <div>
                        <strong>Notion memory connector</strong>
                        <p>Notion setup and synchronization live in Memory, where private/shared destination and forget behavior can be reviewed together.</p>
                      </div>
                      <button type="button" onClick={() => setStudioTab("memory")}>Open Memory</button>
                    </div>
                  </section>
                </div>
              )}

              {studioTab === "archive" && (
                <div className="settings-section">
                  <div className="section-intro">
                    <h3>Archived chats</h3>
                    <p>Archived conversations stay intact until you restore or permanently delete them.</p>
                  </div>
                  <div className="archive-settings-list">
                    {conversations.filter((conversation) => conversation.archivedAt).map((conversation) => (
                      <article key={conversation.id} className="continuity-card">
                        <div>
                          <strong>{conversation.title}</strong>
                          <small>{conversation.members.map((member) => member.name).join(" + ")} · archived {new Date(conversation.archivedAt as string).toLocaleDateString()}</small>
                        </div>
                        <div className="memory-row-actions">
                          <button type="button" onClick={() => void updateConversationArchived(conversation)}>Restore</button>
                          <button type="button" className="forget-memory" onClick={() => void deleteConversation(conversation)}>Delete permanently</button>
                        </div>
                      </article>
                    ))}
                    {!conversations.some((conversation) => conversation.archivedAt) && (
                      <p className="memory-empty">No archived conversations.</p>
                    )}
                  </div>
                </div>
              )}

              {studioTab === "voice" && (
                <div className="settings-section">
                  <div className="section-intro">
                    <h3>Voice</h3>
                    <p>ElevenLabs reads companion replies aloud. The microphone beside the composer turns your speech into editable text before you send it.</p>
                  </div>

                  <section className="continuity-card voice-key-card">
                    <div className="continuity-heading">
                      <span className="memory-logo">11</span>
                      <div>
                        <strong>ElevenLabs</strong>
                        <p>{elevenLabsKey ? "Connected on this device." : "Connect an API key to load your voices and account quota."}</p>
                      </div>
                      <span className="memory-state" data-connected={elevenLabsKey || undefined}>
                        {elevenLabsKey ? "Connected" : "Setup"}
                      </span>
                    </div>
                    <div className="notion-key-entry">
                      <input
                        type={showElevenLabsKey ? "text" : "password"}
                        value={elevenLabsKeyDraft}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setElevenLabsKeyDraft(event.target.value)}
                        placeholder={elevenLabsKey ? "Enter a replacement ElevenLabs key" : "Paste ElevenLabs API key"}
                        aria-label="ElevenLabs API key"
                      />
                      <button type="button" onClick={() => setShowElevenLabsKey((current) => !current)}>
                        {showElevenLabsKey ? "Hide" : "Show"}
                      </button>
                      <button type="button" onClick={() => void saveElevenLabsKey()} disabled={!elevenLabsKeyDraft.trim()}>
                        Save on device
                      </button>
                    </div>
                    <div className="notion-actions">
                      <button type="button" className="sync-button" onClick={() => void refreshElevenLabs()} disabled={!elevenLabsKey || loadingVoice}>
                        {loadingVoice ? "Checking…" : "Refresh voices and quota"}
                      </button>
                      {elevenLabsKey && <button type="button" className="remove-key" onClick={removeElevenLabsKey}>Remove device key</button>}
                    </div>
                  </section>

                  {elevenSubscription && (
                    <section className="voice-quota">
                      <div>
                        <span>{elevenSubscription.tier} plan · {elevenSubscription.status}</span>
                        <strong>{Math.max(0, elevenSubscription.characterLimit - elevenSubscription.characterCount).toLocaleString()}</strong>
                        <small>characters left from {elevenSubscription.characterLimit.toLocaleString()}</small>
                      </div>
                      <div className="usage-track">
                        <i
                          style={{
                            width: `${Math.min(
                              100,
                              elevenSubscription.characterLimit
                                ? (elevenSubscription.characterCount / elevenSubscription.characterLimit) * 100
                                : 0,
                            )}%`,
                          }}
                        />
                      </div>
                      {elevenSubscription.currentOverage > 0 && (
                        <small>${elevenSubscription.currentOverage.toFixed(2)} current overage</small>
                      )}
                    </section>
                  )}

                  <label>
                    <span>{editing.name}’s read-aloud voice</span>
                    <select
                      value={voiceSettings.voiceByCompanion[editing.id] || ""}
                      onChange={(event) =>
                        persistVoiceSettings({
                          ...voiceSettings,
                          voiceByCompanion: {
                            ...voiceSettings.voiceByCompanion,
                            [editing.id]: event.target.value,
                          },
                        })
                      }
                      disabled={!elevenVoices.length}
                    >
                      <option value="">{loadingVoice ? "Loading voices…" : "Choose a voice"}</option>
                      {elevenVoices.map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.name} · {voice.category}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    <span>Read-aloud model</span>
                    <select
                      value={companionVoiceModel(editing.id)}
                      onChange={(event) =>
                        persistVoiceSettings({
                          ...voiceSettings,
                          modelByCompanion: {
                            ...voiceSettings.modelByCompanion,
                            [editing.id]: event.target.value,
                          },
                        })
                      }
                    >
                      <option value="eleven_flash_v2_5">Flash v2.5 · fastest and cheaper</option>
                      <option value="eleven_turbo_v2_5">Turbo v2.5 · balanced</option>
                      <option value="eleven_multilingual_v2">Multilingual v2 · richer long-form voice</option>
                      <option value="eleven_v3">Eleven v3 · most expressive</option>
                    </select>
                    <small>
                      Multilingual v2 usually holds a designed accent more faithfully than Flash.
                      Flash begins sooner, with a greater chance of smoothing the voice toward
                      generic English.
                    </small>
                  </label>

                  <section className="voice-tuning-card">
                    <div className="voice-tuning-heading">
                      <div>
                        <strong>{editing.name}’s voice tuning</strong>
                        <p>These settings apply to API read-aloud only. The library sample is a prerecorded reference.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          updateCompanionVoiceTuning(editing.id, ACCENT_VOICE_TUNING)
                        }
                      >
                        Accent preset
                      </button>
                    </div>

                    <div className="voice-tuning-state">
                      <span>
                        {voiceSettings.tuningByCompanion[editing.id]
                          ? "Custom API settings active"
                          : "Using the voice’s saved ElevenLabs settings"}
                      </span>
                      {voiceSettings.tuningByCompanion[editing.id] && (
                        <button
                          type="button"
                          onClick={() => {
                            const nextTuning = {
                              ...voiceSettings.tuningByCompanion,
                            };
                            delete nextTuning[editing.id];
                            persistVoiceSettings({
                              ...voiceSettings,
                              tuningByCompanion: nextTuning,
                            });
                          }}
                        >
                          Use voice defaults
                        </button>
                      )}
                    </div>

                    <label className="voice-slider">
                      <span>
                        Stability
                        <b>{companionVoiceTuning(editing.id).stability.toFixed(2)}</b>
                      </span>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={companionVoiceTuning(editing.id).stability}
                        onChange={(event) =>
                          updateCompanionVoiceTuning(editing.id, {
                            stability: Number(event.target.value),
                          })
                        }
                      />
                      <small>Lower gives more variation and expression. Higher gets steadier and can flatten delivery.</small>
                    </label>

                    <label className="voice-slider">
                      <span>
                        Similarity
                        <b>{companionVoiceTuning(editing.id).similarityBoost.toFixed(2)}</b>
                      </span>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={companionVoiceTuning(editing.id).similarityBoost}
                        onChange={(event) =>
                          updateCompanionVoiceTuning(editing.id, {
                            similarityBoost: Number(event.target.value),
                          })
                        }
                      />
                      <small>Higher keeps the generated speech closer to the original speaker and accent.</small>
                    </label>

                    <label className="voice-slider">
                      <span>
                        Style
                        <b>{companionVoiceTuning(editing.id).style.toFixed(2)}</b>
                      </span>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={companionVoiceTuning(editing.id).style}
                        onChange={(event) =>
                          updateCompanionVoiceTuning(editing.id, {
                            style: Number(event.target.value),
                          })
                        }
                      />
                      <small>Amplifies the sample’s delivery. Small changes are useful; high values can get unstable and add lag.</small>
                    </label>

                    {companionVoiceModel(editing.id) !== "eleven_v3" && (
                      <label className="voice-slider">
                        <span>
                          Speed
                          <b>{companionVoiceTuning(editing.id).speed.toFixed(2)}×</b>
                        </span>
                        <input
                          type="range"
                          min="0.7"
                          max="1.2"
                          step="0.01"
                          value={companionVoiceTuning(editing.id).speed}
                          onChange={(event) =>
                            updateCompanionVoiceTuning(editing.id, {
                              speed: Number(event.target.value),
                            })
                          }
                        />
                        <small>A slight slowdown can keep consonants and cadence clearer.</small>
                      </label>
                    )}

                    <label className="voice-toggle">
                      <span>
                        <strong>Speaker boost</strong>
                        <small>Pushes the output closer to the original speaker. It can add a little generation time.</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={companionVoiceTuning(editing.id).speakerBoost}
                        onChange={(event) =>
                          updateCompanionVoiceTuning(editing.id, {
                            speakerBoost: event.target.checked,
                          })
                        }
                      />
                    </label>
                  </section>

                  {elevenVoices.find(
                    (voice) => voice.id === voiceSettings.voiceByCompanion[editing.id],
                  )?.previewUrl && (
                    <audio
                      className="voice-preview"
                      controls
                      src={
                        elevenVoices.find(
                          (voice) => voice.id === voiceSettings.voiceByCompanion[editing.id],
                        )?.previewUrl || undefined
                      }
                    />
                  )}

                  <section className="continuity-card dictation-card">
                    <div className="continuity-heading">
                      <span className="memory-logo">●</span>
                      <div>
                        <strong>Talk to text</strong>
                        <p>Tap the microphone beside the message box, speak, then edit the transcription normally before sending. It uses the installed browser’s speech recognition, so it does not consume ElevenLabs characters.</p>
                      </div>
                      <span className="memory-state" data-connected>Live</span>
                    </div>
                  </section>
                </div>
              )}

              {studioTab === "memory" && (
                <div className="settings-section">
                  <div className="section-intro memory-room-intro">
                    <div>
                      <h3>Continuity shelves</h3>
                      <p>Your profile is always loaded. Shared memory follows you into every room; private memory holds companion-specific lore and relationship continuity.</p>
                    </div>
                    <button type="button" onClick={() => void exportMemoryArchive()}>
                      Export all memory
                    </button>
                  </div>

                  {memoryTidyDue && (
                    <section className="continuity-card memory-tidy-card">
                      <div>
                        <strong>Monthly memory review is due</strong>
                        <p>Search both shelves below, correct anything stale, and forget anything the companions should stop carrying.</p>
                      </div>
                      <button type="button" onClick={() => void finishMemoryReview()}>Finish review</button>
                    </section>
                  )}
                  {!memoryTidyDue && memoryLastReviewedAt && (
                    <small className="memory-review-date">Last full review {new Date(memoryLastReviewedAt).toLocaleDateString()}.</small>
                  )}

                  <label className="memory-companion-picker">
                    <span>Private shelf owner</span>
                    <select
                      value={memoryCompanion.id}
                      onChange={(event) => {
                        const nextId = event.target.value;
                        setMemoryCompanionId(nextId);
                        setMemoryQuery("");
                        setEditingMemoryId(null);
                        setDuplicateProposals([]);
                        setSelectedDuplicateProposalIds([]);
                        setDuplicateScanCount(0);
                        void searchMemories("", memoryShelf, false, nextId);
                        void loadMemoryImports(nextId);
                      }}
                    >
                      {companions.map((item) => (
                        <option key={item.id} value={item.id}>{item.name}</option>
                      ))}
                    </select>
                    <small>This selector changes which private shelf you inspect. It does not edit the companion’s identity.</small>
                  </label>

                  <div className="memory-shelf-switch" role="tablist" aria-label="Memory shelf">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={memoryShelf === "shared"}
                      data-active={memoryShelf === "shared" || undefined}
                      onClick={() => {
                        setMemoryShelf("shared");
                        setMemoryQuery("");
                        void searchMemories("", "shared");
                      }}
                    >
                      <span>✦</span>
                      <strong>Everyone</strong>
                      <small>Rules, facts, and continuity every companion can use</small>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={memoryShelf === "companion"}
                      data-active={memoryShelf === "companion" || undefined}
                      onClick={() => {
                        setMemoryShelf("companion");
                        setMemoryQuery("");
                        void searchMemories("", "companion");
                      }}
                    >
                      <span>{memoryCompanion.name.slice(0, 1).toUpperCase()}</span>
                      <strong>{memoryCompanion.name}</strong>
                      <small>Lore and memories reserved for this companion</small>
                    </button>
                  </div>

                  <section className="continuity-card">
                    <div className="continuity-heading">
                      <span className="memory-logo">B</span>
                      <div><strong>About you</strong><p>This stable profile tells every companion who they are speaking with in every new chat.</p></div>
                    </div>
                    <label><span>Your name</span><input value={editingProfile.displayName} onChange={(event) => setEditingProfile({ ...editingProfile, displayName: event.target.value })} /></label>
                    {memoryCompanion.id === "kian" && (
                      <label><span>Relationship to Kian</span><input value={editingProfile.relationship} onChange={(event) => setEditingProfile({ ...editingProfile, relationship: event.target.value })} placeholder="How Kian understands your relationship" /></label>
                    )}
                    <label>
                      <span>About you</span>
                      <textarea
                        className="profile-editor"
                        rows={10}
                        value={editingProfile.profileText}
                        onChange={(event) => setEditingProfile({ ...editingProfile, profileText: event.target.value })}
                        placeholder="Important stable context about you, your life, preferences, and relationship…"
                      />
                      <small>{editingProfile.profileText.length.toLocaleString()} characters · sent with every message</small>
                    </label>
                  </section>

                  <section className="continuity-card memory-engine-card">
                    <div className="continuity-heading">
                      <span className="memory-logo">↻</span>
                      <div>
                        <strong>Live conversation memory</strong>
                        <p>Active now. Every reply receives shared and companion memory. “Remember this…” saves immediately; longer chats are distilled automatically, and a chat returning after 45 quiet minutes is consolidated on its next reply.</p>
                      </div>
                      <span className="memory-state" data-connected>Active</span>
                    </div>
                    <div className="memory-routing">
                      <span><b>General facts, rules, family, preferences</b><small>Filed to Everyone</small></span>
                      <span><b>Relationship history and companion lore</b><small>Filed to {memoryCompanion.name}</small></span>
                      <span><b>Group-chat continuity</b><small>Filed to Everyone</small></span>
                    </div>
                  </section>

                  <section className="continuity-card memory-import-card">
                    <div className="continuity-heading">
                      <span className="memory-logo">⇧</span>
                      <div>
                        <strong>Import a memory archive</strong>
                        <p>Upload the pile. {memoryCompanion.name}’s active model extracts durable memories, blocks exact repeats, separates shared facts from private lore, then prepares semantic duplicate groups for your review.</p>
                      </div>
                    </div>
                    <input
                      ref={memoryImportInputRef}
                      id="memory-archive-input"
                      className="memory-import-input"
                      type="file"
                      multiple
                      accept=".zip,.txt,.md,.json,.jsonl,.csv,.tsv,.html,.xml,.pdf,text/plain,text/markdown,application/json,application/pdf,application/zip"
                      disabled={importingMemory}
                      onClick={(event) => {
                        event.currentTarget.value = "";
                      }}
                      onChange={(event) => void importMemoryFiles(event.target.files)}
                    />
                    {importingMemory && (
                      <div className="memory-import-progress" role="status">
                        <span aria-hidden="true" />
                        {memoryImportProgress || "Reading, separating, and filing…"}
                      </div>
                    )}
                    <small className="memory-import-note">ZIP, TXT, Markdown, JSON, CSV, HTML, XML, or PDF · up to 12 MB per file · the untouched upload is preserved before extraction · any extraction cap is shown in the audit below · this uses the companion’s current model and appears in API spending</small>
                    {memoryImports.length > 0 && (
                      <div className="memory-import-audit">
                        <strong>Import audit</strong>
                        {memoryImports.map((item) => (
                          <div key={item.id}>
                            <span>
                              <b>{item.filename}</b>
                              <small>{new Date(item.createdAt).toLocaleString()}</small>
                            </span>
                            <span>
                              <b>{item.importedCount} filed</b>
                              <small>{item.completedParts}/{item.totalParts} sections · {(item.sizeBytes / 1024).toFixed(0)} KB</small>
                            </span>
                            <i data-warning={item.truncated || undefined}>
                              {item.truncated ? "Source preserved · extraction capped" : item.status}
                            </i>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="continuity-card duplicate-cleanup-card">
                    <div className="continuity-card-heading">
                      <div>
                        <strong>Semantic duplicate cleanup</strong>
                        <p>Exact copies are caught deterministically. Only same-owner, same-category pairs with strong wording overlap reach {memoryCompanion.name}’s current model for strict equivalence validation. You decide what changes.</p>
                      </div>
                      <span className="memory-state" data-connected={duplicateProposals.length > 0 || undefined}>
                        {scanningDuplicates
                          ? "Scanning"
                          : duplicateProposals.length
                            ? `${duplicateProposals.length} to review`
                            : duplicateScanCount
                              ? "Reviewed"
                              : "Ready"}
                      </span>
                    </div>
                    <div className="duplicate-cleanup-actions">
                      <button
                        type="button"
                        className="sync-button"
                        disabled={scanningDuplicates || mergingDuplicates || importingMemory}
                        onClick={() => void scanSemanticDuplicates()}
                      >
                        {scanningDuplicates ? "Comparing memories…" : "Scan for semantic duplicates"}
                      </button>
                      <small>Uses the active model and appears in API spending. Scanning never edits or deletes a memory.</small>
                    </div>
                    {duplicateProposals.length > 0 && (
                      <div className="duplicate-review">
                        <div className="duplicate-review-heading">
                          <span>
                            <strong>Review proposed merges</strong>
                            <small>{duplicateProposals.reduce((total, proposal) => total + proposal.memoryIds.length - 1, 0)} redundant copies across {duplicateProposals.length} groups</small>
                          </span>
                          <span>
                            <button
                              type="button"
                              onClick={() => setSelectedDuplicateProposalIds(duplicateProposals.map((proposal) => proposal.id))}
                            >
                              Select all
                            </button>
                            <button type="button" onClick={() => setSelectedDuplicateProposalIds([])}>
                              Clear
                            </button>
                          </span>
                        </div>
                        <div className="duplicate-proposal-list">
                          {duplicateProposals.map((proposal, index) => {
                            const selected = selectedDuplicateProposalIds.includes(proposal.id);
                            return (
                              <article key={proposal.id} className="duplicate-proposal" data-selected={selected || undefined}>
                                <label className="duplicate-proposal-select">
                                  <input
                                    type="checkbox"
                                    checked={selected}
                                    onChange={(event) =>
                                      setSelectedDuplicateProposalIds((current) =>
                                        event.target.checked
                                          ? [...current, proposal.id]
                                          : current.filter((id) => id !== proposal.id),
                                      )
                                    }
                                  />
                                  <span>
                                    <strong>Group {index + 1} · {proposal.memoryIds.length} copies</strong>
                                    <small>{proposal.ownerId === "shared" ? "Everyone" : `${memoryCompanion.name} only`} · {proposal.reason}</small>
                                  </span>
                                </label>
                                <details>
                                  <summary>Compare original wording</summary>
                                  <div className="duplicate-originals">
                                    {proposal.originals.map((original) => (
                                      <div key={original.id}>
                                        <span>{original.category}</span>
                                        <p>{original.content}</p>
                                      </div>
                                    ))}
                                  </div>
                                </details>
                                <label className="duplicate-merged-memory">
                                  <span>Retained memory—edit before approving</span>
                                  <textarea
                                    rows={4}
                                    value={proposal.mergedContent}
                                    onChange={(event) => editDuplicateProposal(proposal.id, event.target.value)}
                                  />
                                </label>
                              </article>
                            );
                          })}
                        </div>
                        <button
                          type="button"
                          className="merge-duplicates-button"
                          disabled={mergingDuplicates || selectedDuplicateProposalIds.length === 0}
                          onClick={() => void mergeSelectedDuplicates()}
                        >
                          {mergingDuplicates
                            ? "Saving reviewed merges…"
                            : `Merge ${selectedDuplicateProposalIds.length} selected ${selectedDuplicateProposalIds.length === 1 ? "group" : "groups"}`}
                        </button>
                      </div>
                    )}
                  </section>

                  <section className="continuity-card notion-card">
                    <div className="continuity-card-heading">
                      <div>
                        <strong>Supabase memory database</strong>
                        <p>Private and shared memories are retrieved from Supabase on every reply using ranked full-text and fuzzy search across the recent room conversation.</p>
                      </div>
                      <span className="memory-state" data-connected={Boolean(supabaseUrl && supabaseKey) || undefined}>
                        {supabaseUrl && supabaseKey ? "Connected" : "Setup needed"}
                      </span>
                    </div>
                    <p className="notion-memory-explainer">
                      Run the one-time schema in your Supabase SQL Editor, then connect the project here. Connecting migrates the memories already in Companion Lab; the existing copy stays intact as a recovery source.
                    </p>
                    <div className="supabase-setup-actions" aria-label="Supabase schema setup">
                      <button type="button" onClick={() => void copySupabaseSetupSql()}>
                        Copy setup SQL
                      </button>
                      <a href="/supabase-memory-setup.sql" download="companion-lab-supabase-setup.sql">
                        Download SQL file
                      </a>
                    </div>
                    <label>
                      <span>Supabase project URL</span>
                      <input
                        value={supabaseUrlDraft}
                        onChange={(event) => setSupabaseUrlDraft(event.target.value)}
                        placeholder="https://your-project.supabase.co"
                        spellCheck={false}
                      />
                    </label>
                    <div className="notion-key-entry">
                      <input
                        type={showSupabaseKey ? "text" : "password"}
                        value={supabaseKeyDraft}
                        onChange={(event) => setSupabaseKeyDraft(event.target.value)}
                        placeholder={supabaseKey ? "Enter a replacement private key" : "Paste Supabase Secret or Legacy service_role key"}
                        aria-label="Supabase secret or service-role key"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button type="button" onClick={() => setShowSupabaseKey((visible) => !visible)}>
                        {showSupabaseKey ? "Hide" : "Show"}
                      </button>
                      <button type="button" onClick={() => void saveSupabaseMemoryConnection()} disabled={checkingSupabase || !supabaseUrlDraft.trim() || (!supabaseKeyDraft.trim() && !supabaseKey)}>
                        {checkingSupabase ? "Connecting…" : supabaseUrl && supabaseKey ? "Reconnect" : "Connect + migrate"}
                      </button>
                    </div>
                    {supabaseUrl && supabaseKey && (
                      <button type="button" className="remove-key" onClick={removeSupabaseMemoryConnection}>
                        Disconnect on this device
                      </button>
                    )}
                    <small>Use a Secret key beginning with sb_secret_ or the Legacy service_role key. Publishable and anon keys cannot access private memory. The key stays in this device’s private storage and travels over HTTPS only to the private Companion Lab backend.</small>
                  </section>

                  <section className="continuity-card notion-card">
                    <div className="continuity-heading">
                      <span className="memory-logo">N</span>
                      <div>
                        <strong>Notion memory base</strong>
                        <p>Sync a Notion page or database into the destination you choose below.</p>
                      </div>
                      <span className="memory-state" data-connected={Boolean(notionToken && userProfile.notionLastSyncedAt) || undefined}>
                        {notionToken && userProfile.notionLastSyncedAt
                          ? "Synced"
                          : notionToken && userProfile.notionSource
                            ? "Ready"
                            : "Setup"}
                      </span>
                    </div>
                    <small className="notion-access-check">READ + WRITE CONNECTION.</small>
                    <p className="notion-memory-explainer">
                      Sync runs both ways: Notion pages become searchable memory, app memories are written back as readable pages, and later Notion edits are pulled into the original memory on the next sync.
                    </p>
                    <div className="notion-destination" role="radiogroup" aria-label="Notion memory destination">
                      <span>File this Notion source under</span>
                      <div>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={notionDestination === "companion"}
                          data-active={notionDestination === "companion" || undefined}
                          onClick={() => setNotionDestination("companion")}
                        >
                          <b>{memoryCompanion.name} only</b>
                          <small>Private lore and continuity</small>
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={notionDestination === "shared"}
                          data-active={notionDestination === "shared" || undefined}
                          onClick={() => setNotionDestination("shared")}
                        >
                          <b>Everyone</b>
                          <small>Available to every companion</small>
                        </button>
                      </div>
                    </div>
                    <label>
                      <span>Page URL, database URL, or data source ID</span>
                      <input
                        value={editingProfile.notionSource}
                        onChange={(event) => setEditingProfile({ ...editingProfile, notionSource: event.target.value })}
                        placeholder="Paste Kian’s Corner or a memory database link"
                      />
                      <small>Share that page or database with your Notion integration before syncing.</small>
                    </label>
                    <div className="notion-key-entry">
                      <input
                        type={showNotionToken ? "text" : "password"}
                        value={notionTokenDraft}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setNotionTokenDraft(event.target.value)}
                        placeholder={notionToken ? "Enter a replacement Notion token" : "Paste Notion integration token"}
                        aria-label="Notion integration token"
                      />
                      <button type="button" onClick={() => setShowNotionToken((visible) => !visible)}>
                        {showNotionToken ? "Hide" : "Show"}
                      </button>
                      <button type="button" onClick={saveNotionToken} disabled={!notionTokenDraft.trim()}>
                        Save on device
                      </button>
                    </div>
                    <div className="notion-actions">
                      <button type="button" className="sync-button" onClick={() => void syncNotion()} disabled={syncingNotion}>
                        {syncingNotion ? "Syncing…" : "Sync Notion now"}
                      </button>
                      {notionToken && <button type="button" className="remove-key" onClick={removeNotionToken}>Remove device token</button>}
                      {userProfile.notionLastSyncedAt && (
                        <small>Last synced {new Date(userProfile.notionLastSyncedAt).toLocaleString()}</small>
                      )}
                    </div>
                  </section>

                  <details className="continuity-card manual-memory-card">
                    <summary>
                      <span className="memory-logo">✦</span>
                      <span><strong>Add one memory manually</strong><small>Useful for a precise correction or rule. Archive import and live memory handle the bulk work.</small></span>
                    </summary>
                    <div className="memory-compose">
                      <select value={newMemoryCategory} onChange={(event) => setNewMemoryCategory(event.target.value)}>
                        <option value="memory">Memory</option>
                        <option value="rule">Rule</option>
                        <option value="correction">Correction</option>
                        <option value="preference">Preference</option>
                        <option value="relationship">Relationship</option>
                        <option value="event">Event</option>
                      </select>
                      <textarea value={newMemory} onChange={(event) => setNewMemory(event.target.value)} rows={3} placeholder={memoryShelf === "shared" ? "Something every companion should carry into future chats…" : `Something ${memoryCompanion.name} should carry into future chats…`} />
                      <button type="button" onClick={() => void addMemory()} disabled={!newMemory.trim() || loadingMemory}>Save memory</button>
                    </div>
                  </details>

                  <section className="continuity-card memory-browser">
                    <div className="memory-browser-heading">
                      <div>
                        <strong>{memoryShelf === "shared" ? "Everyone’s memory" : `${memoryCompanion.name}’s memory`}</strong>
                        <small>
                          {memoryCount.toLocaleString()} matching · {memoryShelfCount.toLocaleString()} total on this shelf
                        </small>
                      </div>
                      <div>
                        <input
                          value={memoryQuery}
                          onChange={(event) => setMemoryQuery(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void searchMemories();
                          }}
                          placeholder="Search memory"
                          aria-label="Search long-term memory"
                        />
                        <button type="button" onClick={() => void searchMemories()} disabled={loadingMemory}>{loadingMemory ? "…" : "Search"}</button>
                      </div>
                    </div>
                    <div className="memory-review-tools">
                      <label>
                        <span>Category</span>
                        <select value={memoryCategory} onChange={(event) => setMemoryCategory(event.target.value)}>
                          <option value="all">All categories</option>
                          <option value="memory">Memories</option>
                          <option value="rule">Rules</option>
                          <option value="correction">Corrections</option>
                          <option value="preference">Preferences</option>
                          <option value="relationship">Relationships</option>
                          <option value="event">Events</option>
                        </select>
                      </label>
                      <label>
                        <span>Source</span>
                        <select value={memorySource} onChange={(event) => setMemorySource(event.target.value)}>
                          <option value="all">All sources</option>
                          <option value="import">Imported archives</option>
                          <option value="chat">Live chat</option>
                          <option value="manual">Manual</option>
                          <option value="notion">Notion</option>
                        </select>
                      </label>
                      <button type="button" onClick={() => void searchMemories()} disabled={loadingMemory}>Apply filters</button>
                    </div>
                    <div className="memory-selection-bar">
                      <label>
                        <input
                          type="checkbox"
                          checked={Boolean(memoryResults.length) && memoryResults.every((memory) => selectedMemoryIds.includes(memory.id))}
                          onChange={(event) => {
                            setSelectedMemoryIds(event.target.checked ? memoryResults.map((memory) => memory.id) : []);
                          }}
                        />
                        Select loaded
                      </label>
                      <span>{selectedMemoryIds.length ? `${selectedMemoryIds.length} selected` : `${memoryResults.length} loaded`}</span>
                      {selectedMemoryIds.length > 0 && (
                        <button type="button" className="forget-memory" onClick={() => void forgetSelectedMemories()} disabled={loadingMemory}>
                          Forget selected
                        </button>
                      )}
                    </div>
                    <div className="memory-results">
                      {memoryResults.map((memory) => (
                        <article key={memory.id} data-selected={selectedMemoryIds.includes(memory.id) || undefined}>
                          <label className="memory-select">
                            <input
                              type="checkbox"
                              checked={selectedMemoryIds.includes(memory.id)}
                              onChange={(event) => {
                                setSelectedMemoryIds((current) =>
                                  event.target.checked
                                    ? [...new Set([...current, memory.id])]
                                    : current.filter((id) => id !== memory.id),
                                );
                              }}
                            />
                            <span className="sr-only">Select this memory</span>
                          </label>
                          <div><span>{memory.category}</span><small>{memory.source}{memory.pinned ? " · pinned" : ""} · {memory.ownerId === "shared" ? "everyone" : memoryCompanion.name}</small></div>
                          {editingMemoryId === memory.id ? (
                            <div className="memory-inline-editor">
                              <select value={editingMemoryCategory} onChange={(event) => setEditingMemoryCategory(event.target.value)}>
                                <option value="memory">Memory</option>
                                <option value="rule">Rule</option>
                                <option value="correction">Correction</option>
                                <option value="preference">Preference</option>
                                <option value="relationship">Relationship</option>
                                <option value="event">Event</option>
                              </select>
                              <textarea rows={4} value={editingMemoryContent} onChange={(event) => setEditingMemoryContent(event.target.value)} />
                              <div>
                                <button type="button" onClick={() => setEditingMemoryId(null)}>Cancel</button>
                                <button type="button" onClick={() => void saveMemoryEdit(memory)} disabled={loadingMemory || !editingMemoryContent.trim()}>Save correction</button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <p>{memory.content}</p>
                              <div className="memory-item-actions">
                                {memory.sourceUrl && <a href={memory.sourceUrl} target="_blank" rel="noreferrer">Open in Notion</a>}
                                <button type="button" onClick={() => beginEditMemory(memory)} disabled={loadingMemory}>Edit</button>
                                <button type="button" onClick={() => void moveMemory(memory)} disabled={loadingMemory}>
                                  {memory.ownerId === "shared" ? `Move to ${memoryCompanion.name}` : "Move to Everyone"}
                                </button>
                                <button type="button" className="forget-memory" onClick={() => void forgetMemory(memory)} disabled={loadingMemory}>
                                  Forget
                                </button>
                              </div>
                            </>
                          )}
                        </article>
                      ))}
                      {!memoryResults.length && <p className="memory-empty">The shelves are ready. Add something or sync Notion.</p>}
                    </div>
                    {memoryHasMore && (
                      <button type="button" className="memory-load-more" onClick={() => void searchMemories(memoryQuery, memoryShelf, true)} disabled={loadingMemory}>
                        {loadingMemory ? "Loading…" : `Load more (${Math.max(0, memoryCount - memoryResults.length).toLocaleString()} remaining)`}
                      </button>
                    )}
                  </section>
                </div>
              )}
            </div>

            <footer className="studio-footer">
              <span>
                {studioTab === "companions"
                  ? `${companions.length} ${companions.length === 1 ? "companion" : "companions"}`
                  : studioTab === "memory"
                    ? `${memoryCount.toLocaleString()} memories on ${memoryShelf === "shared" ? "Everyone" : memoryCompanion.name}`
                    : studioTab === "budget"
                      ? `${usage.messages} tracked API runs this month`
                      : studioTab === "voice"
                        ? elevenSubscription
                          ? `${Math.max(0, elevenSubscription.characterLimit - elevenSubscription.characterCount).toLocaleString()} ElevenLabs characters left`
                          : "ElevenLabs read aloud and browser talk-to-text"
                      : studioTab === "connectors"
                        ? webSearchEnabled ? "Web search available on demand" : "On-demand tools are off"
                      : studioTab === "archive"
                        ? `${archivedConversationCount} archived ${archivedConversationCount === 1 ? "chat" : "chats"}`
                      : loadingConfig
                        ? "Loading saved profile…"
                        : `Current identity version ${editing.version}`}
              </span>
              <div>
                <button className="quiet-button" onClick={() => setStudioTab(null)}>Cancel</button>
                {studioTab === "companions" ? (
                  <button className="save-button" onClick={beginNewCompanion}>Add companion</button>
                ) : studioTab === "voice" || studioTab === "connectors" || studioTab === "archive" ? (
                  <button className="save-button" onClick={() => setStudioTab(null)}>Done</button>
                ) : (
                  <button
                    className="save-button"
                    onClick={() =>
                      void (studioTab === "memory"
                        ? saveMemorySettings()
                        : studioTab === "budget"
                          ? saveUsageBudget()
                          : saveCompanion())
                    }
                    disabled={saving}
                  >
                    {saving ? "Saving…" : "Save changes"}
                  </button>
                )}
              </div>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}
