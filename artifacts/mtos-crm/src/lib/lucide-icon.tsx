import {
  Play, Webhook, Clock, UserPlus, GitBranch, Shuffle, Repeat, Hourglass,
  Variable, Wand2, Scissors, Crosshair, Table2, UserCog, ShieldCheck,
  Briefcase, StickyNote, ClipboardList, Mail, Printer, FileSignature,
  Globe, Network, Brain, FileText, Sparkles, Code2, Terminal, TerminalSquare,
  Database, FileDown, FileUp, MessageSquare, Square, Search, Box,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  Play, Webhook, Clock, UserPlus, GitBranch, Shuffle, Repeat, Hourglass,
  Variable, Wand2, Scissors, Crosshair, Table2, UserCog, ShieldCheck,
  Briefcase, StickyNote, ClipboardList, Mail, Printer, FileSignature,
  Globe, Network, Brain, FileText, Sparkles, Code2, Terminal, TerminalSquare,
  Database, FileDown, FileUp, MessageSquare, Square, Search,
};

export function getLucide(name?: string | null): LucideIcon {
  if (!name) return Box;
  return ICONS[name] ?? Box;
}
