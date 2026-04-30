import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { MessageSquare, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";

interface SendSmsButtonProps {
  leadId: number;
  hasPhone: boolean;
  size?: "sm" | "default";
  variant?: "default" | "outline" | "ghost" | "secondary";
  className?: string;
  onSent?: () => void;
}

interface SendSmsResponse {
  status: "ok";
  data: {
    sms_message_id: number;
    telnyx_message_id?: string;
  };
}

export function SendSmsButton({
  leadId,
  hasPhone,
  size = "sm",
  variant = "outline",
  className,
  onSent,
}: SendSmsButtonProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  const reset = () => {
    setBody("");
    setSending(false);
  };

  async function handleSend() {
    const trimmed = body.trim();
    if (!trimmed) {
      toast({ title: "Message is empty", variant: "destructive" });
      return;
    }
    setSending(true);
    try {
      const res = await apiFetch<SendSmsResponse>(`/api/leads/${leadId}/send-sms`, {
        method: "POST",
        body: JSON.stringify({ body: trimmed }),
      });
      toast({
        title: "SMS queued",
        description: `Message sent (id ${res.data.sms_message_id}).`,
      });
      setOpen(false);
      reset();
      onSent?.();
    } catch (err) {
      toast({
        title: "SMS failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button
          size={size}
          variant={variant}
          className={className}
          disabled={!hasPhone}
          title={hasPhone ? "Send SMS" : "No phone number on file"}
          data-testid={`button-send-sms-${leadId}`}
        >
          <MessageSquare className="w-4 h-4 mr-2" />
          Send SMS
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="dialog-send-sms">
        <DialogHeader>
          <DialogTitle>Send SMS to lead</DialogTitle>
          <DialogDescription>
            The message is delivered via Telnyx using the firm's configured
            sender number. Carrier rules apply (160 chars per segment,
            disclosure language for unsolicited contact).
          </DialogDescription>
        </DialogHeader>
        <Textarea
          rows={5}
          maxLength={1600}
          placeholder="Type your message…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          data-testid="input-sms-body"
        />
        <div className="text-xs text-muted-foreground text-right">
          {body.length}/1600
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={sending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleSend()}
            disabled={sending || !body.trim()}
            data-testid="button-confirm-send-sms"
          >
            {sending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
