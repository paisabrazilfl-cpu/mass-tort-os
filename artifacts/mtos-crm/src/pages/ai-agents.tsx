import { Bot } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";

export default function AiAgentsPage() {
  const [, setLocation] = useLocation();
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
        <h2 className="text-lg font-medium">Meet Abby</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-xs">
          Your MTOS internal agent is ready. Talk to Abby about your leads,
          cases, compliance, workflows, and more.
        </p>
        <Button className="mt-4" onClick={() => setLocation("/abby")}>
          Open Abby
        </Button>
      </div>
    </div>
  );
}
