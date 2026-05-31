import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send,
  User,
  Loader2,
  Plus,
  Globe,
  Sparkles,
  Paperclip,
  X,
  Trash2,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { apiFetch, apiFetchRaw, describeError } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";

interface Attachment {
  name: string;
  objectPath: string;
  size: number;
  contentType: string;
}

interface Proposal {
  kind: "rebuild_all" | "seo_rebuild_all" | "create_site" | "edit_site";
  summary: string;
  params: Record<string, unknown>;
}

interface ChatMessage {
  id: number;
  conversationId: number;
  role: string;
  content: string;
  attachments: Attachment[] | null;
  proposal: Proposal | null;
  proposalStatus: string | null;
  proposalResult: Record<string, unknown> | null;
  createdAt: string;
}

interface ConversationSummary {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

const KIND_LABEL: Record<Proposal["kind"], string> = {
  rebuild_all: "Rebuild all sites",
  seo_rebuild_all: "Rebuild SEO network",
  create_site: "Create a new site",
  edit_site: "Edit an existing site",
};

const KIND_PRIVILEGE: Record<Proposal["kind"], string> = {
  rebuild_all: "Requires super_admin",
  seo_rebuild_all: "Requires super_admin",
  create_site: "Requires Sites manage permission",
  edit_site: "Requires Sites manage permission",
};

const SUGGESTIONS = [
  "What tort sites are currently live?",
  "Create a new site for the Roundup campaign",
  "Rebuild all sites and backfill their web forms",
  "Rebuild the SEO page network",
];

function AiAvatar({ size = "md" }: { size?: "sm" | "md" }) {
  const dim = size === "sm" ? "w-7 h-7" : "w-8 h-8";
  return (
    <div
      className={cn(
        "flex-shrink-0 flex items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-cyan-600 text-white shadow-sm",
        dim,
      )}
    >
      <Globe className="w-4 h-4" />
    </div>
  );
}

function FormattedText({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <span>
      {lines.map((line, li) => {
        const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
        return (
          <span key={li}>
            {parts.map((part, pi) => {
              if (part.startsWith("**") && part.endsWith("**"))
                return <strong key={pi}>{part.slice(2, -2)}</strong>;
              if (part.startsWith("`") && part.endsWith("`"))
                return (
                  <code key={pi} className="bg-background/50 rounded px-1 font-mono text-xs">
                    {part.slice(1, -1)}
                  </code>
                );
              const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
              if (link) {
                const [, label, href] = link;
                const isInternal = href.startsWith("/");
                return (
                  <a
                    key={pi}
                    href={href}
                    {...(isInternal ? {} : { target: "_blank", rel: "noopener noreferrer" })}
                    className="text-sky-600 dark:text-sky-400 underline underline-offset-2 hover:text-sky-700"
                  >
                    {label}
                  </a>
                );
              }
              return <span key={pi}>{part}</span>;
            })}
            {li < lines.length - 1 && <br />}
          </span>
        );
      })}
    </span>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentChips({
  attachments,
  convoId,
  messageId,
}: {
  attachments: Attachment[];
  convoId: number;
  messageId: number;
}) {
  if (!attachments.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {attachments.map((a, idx) => (
        <a
          key={idx}
          href={`/api/sites-ai/conversations/${convoId}/messages/${messageId}/attachments/${idx}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-[11px] border border-border/60 rounded-md px-2 py-1 bg-background/60 hover:bg-muted/60 transition-colors"
        >
          <FileText className="w-3 h-3 flex-shrink-0" />
          <span className="truncate max-w-[160px]">{a.name}</span>
          <span className="text-muted-foreground">{formatBytes(a.size)}</span>
        </a>
      ))}
    </div>
  );
}

function ProposalCard({
  msg,
  onConfirm,
  onCancel,
  busy,
}: {
  msg: ChatMessage;
  onConfirm: (msg: ChatMessage) => void;
  onCancel: (msg: ChatMessage) => void;
  busy: boolean;
}) {
  const p = msg.proposal!;
  const status = msg.proposalStatus;
  const params = p.params ?? {};
  const detailKeys = Object.keys(params).filter(
    (k) => params[k] != null && typeof params[k] !== "object",
  );
  return (
    <div className="mt-2 rounded-xl border border-amber-400/50 bg-amber-50/60 dark:bg-amber-950/20 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
        <span className="font-semibold text-sm">{KIND_LABEL[p.kind]}</span>
        <Badge variant="outline" className="text-[10px] h-5 ml-auto">
          {KIND_PRIVILEGE[p.kind]}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{p.summary}</p>
      {detailKeys.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
          {detailKeys.map((k) => (
            <div key={k} className="flex gap-1.5">
              <span className="text-muted-foreground">{k}:</span>
              <span className="font-medium truncate">{String(params[k])}</span>
            </div>
          ))}
        </div>
      )}

      {status === "pending" && (
        <div className="flex gap-2 pt-1">
          <Button
            size="sm"
            className="h-7 text-xs bg-amber-600 hover:bg-amber-700 border-0"
            disabled={busy}
            onClick={() => onConfirm(msg)}
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : "Confirm & run"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={busy}
            onClick={() => onCancel(msg)}
          >
            Cancel
          </Button>
        </div>
      )}
      {status === "executed" && (
        <div className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400 pt-0.5">
          <CheckCircle2 className="w-3.5 h-3.5" /> Action completed
        </div>
      )}
      {status === "confirmed" && (
        <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 pt-0.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Running…
        </div>
      )}
      {status === "cancelled" && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground pt-0.5">
          <XCircle className="w-3.5 h-3.5" /> Cancelled
        </div>
      )}
      {status === "failed" && (
        <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400 pt-0.5">
          <XCircle className="w-3.5 h-3.5" /> Failed
        </div>
      )}
    </div>
  );
}

function MessageBubble({
  msg,
  onConfirm,
  onCancel,
  busyProposalId,
}: {
  msg: ChatMessage;
  onConfirm: (msg: ChatMessage) => void;
  onCancel: (msg: ChatMessage) => void;
  busyProposalId: number | null;
}) {
  const isUser = msg.role === "user";
  return (
    <div className={cn("flex gap-3 px-4 py-2.5", isUser && "flex-row-reverse")}>
      {isUser ? (
        <div className="flex-shrink-0 flex items-center justify-center rounded-full w-8 h-8 mt-0.5 bg-primary text-primary-foreground">
          <User className="w-4 h-4" />
        </div>
      ) : (
        <div className="mt-0.5">
          <AiAvatar />
        </div>
      )}
      <div className={cn("max-w-[78%] space-y-1", isUser && "items-end flex flex-col")}>
        <div
          className={cn(
            "rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
            isUser
              ? "bg-primary text-primary-foreground rounded-tr-sm"
              : "bg-muted/60 border border-border/60 rounded-tl-sm",
          )}
        >
          <FormattedText content={msg.content} />
          {!isUser && msg.proposal && (
            <ProposalCard
              msg={msg}
              onConfirm={onConfirm}
              onCancel={onCancel}
              busy={busyProposalId === msg.id}
            />
          )}
        </div>
        {!!(msg.attachments && msg.attachments.length) && (
          <AttachmentChips
            attachments={msg.attachments}
            convoId={msg.conversationId}
            messageId={msg.id}
          />
        )}
        <span className="text-[10px] text-muted-foreground px-1">
          {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
    </div>
  );
}

export default function SitesAiPage() {
  const { toast } = useToast();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loadingReply, setLoadingReply] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busyProposalId, setBusyProposalId] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadConversations = useCallback(async () => {
    try {
      const data = await apiFetch<{ conversations: ConversationSummary[] }>(
        "/api/sites-ai/conversations",
      );
      setConversations(data.conversations);
      return data.conversations;
    } catch (err) {
      toast({ title: "Failed to load chats", description: describeError(err), variant: "destructive" });
      return [];
    }
  }, [toast]);

  const loadThread = useCallback(
    async (id: number) => {
      setLoadingThread(true);
      try {
        const data = await apiFetch<{ messages: ChatMessage[] }>(
          `/api/sites-ai/conversations/${id}`,
        );
        setMessages(data.messages);
      } catch (err) {
        toast({ title: "Failed to load chat", description: describeError(err), variant: "destructive" });
      } finally {
        setLoadingThread(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void (async () => {
      const list = await loadConversations();
      if (list.length > 0) {
        setActiveId(list[0].id);
      }
    })();
  }, [loadConversations]);

  useEffect(() => {
    if (activeId != null) void loadThread(activeId);
    else setMessages([]);
  }, [activeId, loadThread]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loadingReply]);

  const newConversation = useCallback(async () => {
    try {
      const data = await apiFetch<{ conversation: ConversationSummary }>(
        "/api/sites-ai/conversations",
        { method: "POST", body: JSON.stringify({}) },
      );
      setConversations((prev) => [data.conversation, ...prev]);
      setActiveId(data.conversation.id);
      setMessages([]);
      setTimeout(() => textareaRef.current?.focus(), 50);
    } catch (err) {
      toast({ title: "Couldn't start chat", description: describeError(err), variant: "destructive" });
    }
  }, [toast]);

  const deleteConversation = useCallback(
    async (id: number) => {
      try {
        await apiFetch(`/api/sites-ai/conversations/${id}`, { method: "DELETE" });
        setConversations((prev) => prev.filter((c) => c.id !== id));
        if (activeId === id) {
          setActiveId(null);
          setMessages([]);
        }
      } catch (err) {
        toast({ title: "Couldn't delete chat", description: describeError(err), variant: "destructive" });
      }
    },
    [activeId, toast],
  );

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setUploading(true);
      try {
        for (const file of Array.from(files)) {
          const req = await apiFetch<{ uploadURL: string; objectPath: string }>(
            "/api/sites-ai/uploads/request-url",
            {
              method: "POST",
              body: JSON.stringify({
                name: file.name,
                size: file.size,
                contentType: file.type || "application/octet-stream",
              }),
            },
          );
          const put = await fetch(req.uploadURL, {
            method: "PUT",
            headers: { "Content-Type": file.type || "application/octet-stream" },
            body: file,
          });
          if (!put.ok) throw new Error(`Upload failed (${put.status})`);
          setPendingFiles((prev) => [
            ...prev,
            {
              name: file.name,
              objectPath: req.objectPath,
              size: file.size,
              contentType: file.type || "application/octet-stream",
            },
          ]);
        }
      } catch (err) {
        toast({ title: "Upload failed", description: describeError(err), variant: "destructive" });
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [toast],
  );

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if ((!content && pendingFiles.length === 0) || loadingReply) return;

      let convoId = activeId;
      if (convoId == null) {
        try {
          const data = await apiFetch<{ conversation: ConversationSummary }>(
            "/api/sites-ai/conversations",
            { method: "POST", body: JSON.stringify({ title: content.slice(0, 60) || "New Sites chat" }) },
          );
          convoId = data.conversation.id;
          setConversations((prev) => [data.conversation, ...prev]);
          setActiveId(convoId);
        } catch (err) {
          toast({ title: "Couldn't start chat", description: describeError(err), variant: "destructive" });
          return;
        }
      }

      const attachments = pendingFiles;
      setInput("");
      setPendingFiles([]);
      setLoadingReply(true);

      try {
        const data = await apiFetch<{
          userMessage: ChatMessage;
          assistantMessage: ChatMessage;
          error?: { code: string; message: string };
        }>(`/api/sites-ai/conversations/${convoId}/messages`, {
          method: "POST",
          body: JSON.stringify({ content: content || "(see attached files)", attachments }),
        });
        setMessages((prev) => [...prev, data.userMessage, data.assistantMessage]);
        void loadConversations();
      } catch (err) {
        toast({ title: "Message failed", description: describeError(err), variant: "destructive" });
      } finally {
        setLoadingReply(false);
        setTimeout(() => textareaRef.current?.focus(), 50);
      }
    },
    [activeId, pendingFiles, loadingReply, toast, loadConversations],
  );

  const confirmProposal = useCallback(
    async (msg: ChatMessage) => {
      if (activeId == null) return;
      setBusyProposalId(msg.id);
      try {
        await apiFetchRaw(
          `/api/sites-ai/conversations/${activeId}/messages/${msg.id}/confirm`,
          { method: "POST" },
        );
        await loadThread(activeId);
      } catch (err) {
        toast({ title: "Action failed", description: describeError(err), variant: "destructive" });
      } finally {
        setBusyProposalId(null);
      }
    },
    [activeId, loadThread, toast],
  );

  const cancelProposal = useCallback(
    async (msg: ChatMessage) => {
      if (activeId == null) return;
      setBusyProposalId(msg.id);
      try {
        await apiFetch(`/api/sites-ai/conversations/${activeId}/messages/${msg.id}/cancel`, {
          method: "POST",
        });
        await loadThread(activeId);
      } catch (err) {
        toast({ title: "Couldn't cancel", description: describeError(err), variant: "destructive" });
      } finally {
        setBusyProposalId(null);
      }
    },
    [activeId, loadThread, toast],
  );

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const isEmpty = messages.length === 0 && !loadingThread;

  return (
    <div className="flex flex-col h-full space-y-4" style={{ height: "calc(100vh - 80px)" }}>
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <AiAvatar size="md" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Sites AI Assistant</h1>
            <p className="text-sm text-muted-foreground mt-0">
              Manage tort sites &amp; the SEO network · proposes actions you confirm
            </p>
          </div>
        </div>
        <Badge variant="outline" className="text-xs gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block animate-pulse" />
          Online
        </Badge>
      </div>

      <div className="flex-1 flex gap-4 min-h-0">
        {/* Conversation sidebar */}
        <div className="w-60 flex-shrink-0 flex flex-col rounded-xl border border-border bg-background shadow-sm overflow-hidden">
          <div className="p-2 border-b border-border">
            <Button
              onClick={newConversation}
              size="sm"
              className="w-full h-8 text-xs gap-1.5 bg-gradient-to-br from-sky-500 to-cyan-600 hover:from-sky-600 hover:to-cyan-700 border-0"
            >
              <Plus className="w-3.5 h-3.5" /> New chat
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
            {conversations.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4 px-2">
                No chats yet. Start one to manage your sites.
              </p>
            )}
            {conversations.map((c) => (
              <div
                key={c.id}
                className={cn(
                  "group flex items-center gap-1.5 rounded-lg px-2.5 py-2 cursor-pointer transition-colors",
                  c.id === activeId ? "bg-muted" : "hover:bg-muted/60",
                )}
                onClick={() => setActiveId(c.id)}
              >
                <Globe className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="text-xs truncate flex-1">{c.title}</span>
                <button
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-red-500"
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteConversation(c.id);
                  }}
                  title="Delete chat"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Chat window */}
        <div className="flex-1 flex flex-col rounded-xl border border-border bg-background shadow-sm overflow-hidden min-h-0">
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="py-2">
              {loadingThread && (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              )}

              {isEmpty && (
                <div className="px-4 py-8 text-center space-y-4">
                  <AiAvatar size="md" />
                  <div>
                    <p className="text-sm font-medium">Your Sites AI Assistant</p>
                    <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
                      Ask about your tort sites, create or edit a site, or rebuild the network.
                      Privileged actions are always proposed for your confirmation first.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 justify-center max-w-lg mx-auto">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        onClick={() => send(s)}
                        className="text-xs border border-border rounded-lg px-3 py-1.5 hover:bg-muted/60 hover:border-sky-400/50 transition-colors text-muted-foreground hover:text-foreground"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  msg={msg}
                  onConfirm={confirmProposal}
                  onCancel={cancelProposal}
                  busyProposalId={busyProposalId}
                />
              ))}

              {loadingReply && (
                <div className="flex gap-3 px-4 py-2.5">
                  <AiAvatar />
                  <div className="bg-muted/60 border border-border/60 rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Thinking…</span>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Pending attachments */}
          {pendingFiles.length > 0 && (
            <div className="border-t border-border px-3 py-2 flex flex-wrap gap-1.5 bg-muted/20">
              {pendingFiles.map((f, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-1.5 text-[11px] border border-border/60 rounded-md px-2 py-1 bg-background"
                >
                  <FileText className="w-3 h-3" />
                  <span className="truncate max-w-[140px]">{f.name}</span>
                  <button
                    className="text-muted-foreground hover:text-red-500"
                    onClick={() => setPendingFiles((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="border-t border-border p-3 bg-background flex-shrink-0">
            <div className="flex gap-2 items-end">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => handleFiles(e.target.files)}
              />
              <Button
                variant="outline"
                size="icon"
                className="flex-shrink-0 h-[44px] w-[44px]"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                title="Attach files"
              >
                {uploading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Paperclip className="w-4 h-4" />
                )}
              </Button>
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Ask about your sites, or describe a change to make…"
                className="resize-none min-h-[44px] max-h-[140px] text-sm"
                rows={1}
                disabled={loadingReply}
                autoFocus
              />
              <Button
                onClick={() => send(input)}
                disabled={(!input.trim() && pendingFiles.length === 0) || loadingReply}
                size="icon"
                className="flex-shrink-0 h-[44px] w-[44px] bg-gradient-to-br from-sky-500 to-cyan-600 hover:from-sky-600 hover:to-cyan-700 border-0"
              >
                {loadingReply ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5 px-0.5 flex items-center gap-1">
              <Sparkles className="w-2.5 h-2.5" />
              Enter to send · Shift+Enter for new line · Actions require your confirmation
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
