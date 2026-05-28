import { useState, useRef, useEffect, useCallback } from "react";
import { Send, User, Loader2, RefreshCw, ChevronDown, Activity, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/auth-context";
import { getAccessToken } from "@/lib/auth-store";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
}

interface CrmContext {
  leads: { total: number; by_status: Record<string, number> };
  cases: number;
  documents: number;
  pending_jobs: number;
  review_queue: number;
  active_forms: number;
  recent_activity: { action: string; entity_type: string; occurred_at: string }[];
}

const WELCOME: Message = {
  id: "welcome",
  role: "assistant",
  content: `Hi, I'm **Abby** — your MTOS internal agent. I'm fully wired into your CRM and here to help.

I can answer questions about:
- **Your pipeline** — lead counts, status breakdowns, intake trends
- **Cases & documents** — open cases, review queue depth, doc status
- **Compliance & workflows** — TCPA requirements, audit logs, automation setup
- **Operations** — background checks, form campaigns, team assignments, dedup logic

What do you need?`,
  ts: Date.now(),
};

const SUGGESTIONS = [
  "What's my lead pipeline looking like right now?",
  "How many leads are pending review and why?",
  "Walk me through the Round Up intake process",
  "What TCPA steps are required for a new campaign?",
  "How does the background check hub work?",
  "Help me set up an automation for lead triage",
];

function AbbyAvatar({ size = "md" }: { size?: "sm" | "md" }) {
  const dim = size === "sm" ? "w-7 h-7" : "w-8 h-8";
  return (
    <div className={cn("flex-shrink-0 flex items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-white font-bold text-xs shadow-sm", dim)}>
      A
    </div>
  );
}

function FormattedText({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <span>
      {lines.map((line, li) => {
        const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
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
              return <span key={pi}>{part}</span>;
            })}
            {li < lines.length - 1 && <br />}
          </span>
        );
      })}
    </span>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  return (
    <div className={cn("flex gap-3 px-4 py-2.5", isUser && "flex-row-reverse")}>
      {isUser ? (
        <div className="flex-shrink-0 flex items-center justify-center rounded-full w-8 h-8 mt-0.5 bg-primary text-primary-foreground">
          <User className="w-4 h-4" />
        </div>
      ) : (
        <div className="mt-0.5">
          <AbbyAvatar />
        </div>
      )}
      <div className={cn("max-w-[78%] space-y-1", isUser && "items-end flex flex-col")}>
        <div
          className={cn(
            "rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
            isUser
              ? "bg-primary text-primary-foreground rounded-tr-sm"
              : "bg-muted/60 border border-border/60 rounded-tl-sm"
          )}
        >
          <FormattedText content={msg.content} />
        </div>
        <span className="text-[10px] text-muted-foreground px-1">
          {new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
    </div>
  );
}

function CrmStatsBar({ ctx }: { ctx: CrmContext | null }) {
  if (!ctx) return null;
  const statuses = Object.entries(ctx.leads.by_status ?? {});
  return (
    <div className="border-t border-border/50 bg-muted/20 px-4 py-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        <Activity className="w-3 h-3" />
        Live CRM Context
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="outline" className="text-xs h-5">{ctx.leads.total} leads</Badge>
        <Badge variant="outline" className="text-xs h-5">{ctx.cases} cases</Badge>
        <Badge variant="outline" className="text-xs h-5">{ctx.documents} docs</Badge>
        {ctx.review_queue > 0 && (
          <Badge variant="destructive" className="text-xs h-5">{ctx.review_queue} in review</Badge>
        )}
        {ctx.pending_jobs > 0 && (
          <Badge className="text-xs h-5 bg-amber-500 hover:bg-amber-500">{ctx.pending_jobs} jobs pending</Badge>
        )}
        <Badge variant="outline" className="text-xs h-5">{ctx.active_forms} forms live</Badge>
      </div>
      {statuses.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          {statuses.map(([s, n]) => (
            <span key={s} className="text-[10px] text-muted-foreground">
              {s}: <span className="text-foreground font-medium">{n}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AbbyPage() {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [crmCtx, setCrmCtx] = useState<CrmContext | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || loading) return;

      const userMsg: Message = { id: crypto.randomUUID(), role: "user", content, ts: Date.now() };
      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      setLoading(true);
      setShowSuggestions(false);

      const history = messages
        .filter((m) => m.id !== "welcome")
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content }));

      try {
        const token = getAccessToken() ?? "";
        const res = await fetch("/api/ai-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ message: content, history }),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "assistant", content: data.reply, ts: Date.now() },
        ]);
        if (data.crmContext) setCrmCtx(data.crmContext);
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "Sorry, I hit an error. Please try again.",
            ts: Date.now(),
          },
        ]);
      } finally {
        setLoading(false);
        setTimeout(() => textareaRef.current?.focus(), 50);
      }
    },
    [messages, loading]
  );

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const reset = () => {
    setMessages([WELCOME]);
    setInput("");
    setCrmCtx(null);
    setShowSuggestions(true);
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  return (
    <div className="flex flex-col h-full space-y-4" style={{ height: "calc(100vh - 80px)" }}>
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <AbbyAvatar size="md" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Abby</h1>
            <p className="text-sm text-muted-foreground mt-0">
              MTOS internal agent · live CRM access
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block animate-pulse" />
            Online
          </Badge>
          <Button variant="ghost" size="icon" onClick={reset} title="New conversation">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Chat window */}
      <div className="flex-1 flex flex-col rounded-xl border border-border bg-background shadow-sm overflow-hidden min-h-0">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="py-2">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}

            {/* Quick-start suggestions */}
            {showSuggestions && messages.length === 1 && (
              <div className="px-4 py-2">
                <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                  <ChevronDown className="w-3 h-3" />
                  Try asking Abby…
                </p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="text-xs border border-border rounded-lg px-3 py-1.5 hover:bg-muted/60 hover:border-violet-400/50 transition-colors text-left text-muted-foreground hover:text-foreground"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Typing indicator */}
            {loading && (
              <div className="flex gap-3 px-4 py-2.5">
                <AbbyAvatar />
                <div className="bg-muted/60 border border-border/60 rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Abby is thinking…</span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Live CRM context strip */}
        <CrmStatsBar ctx={crmCtx} />

        {/* Input */}
        <div className="border-t border-border p-3 bg-background flex-shrink-0">
          <div className="flex gap-2 items-end">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask Abby about your leads, cases, compliance, workflows…"
              className="resize-none min-h-[44px] max-h-[140px] text-sm"
              rows={1}
              disabled={loading}
              autoFocus
            />
            <Button
              onClick={() => send(input)}
              disabled={!input.trim() || loading}
              size="icon"
              className="flex-shrink-0 h-[44px] w-[44px] bg-gradient-to-br from-violet-500 to-indigo-600 hover:from-violet-600 hover:to-indigo-700 border-0"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground mt-1.5 px-0.5 flex items-center gap-1">
            <Sparkles className="w-2.5 h-2.5" />
            Enter to send · Shift+Enter for new line · Powered by MTOS AI Constitution
          </p>
        </div>
      </div>
    </div>
  );
}
