import { Bot } from "lucide-react";

export default function AiAgentsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">AI Agents</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage and configure your AI agents here.
        </p>
      </div>

      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 py-24 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
          <Bot className="h-7 w-7 text-primary" />
        </div>
        <h2 className="text-lg font-medium">No agents configured yet</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-xs">
          This is where your AI agents will live. Add agents to automate
          intake, triage, outreach, and more.
        </p>
      </div>
    </div>
  );
}
