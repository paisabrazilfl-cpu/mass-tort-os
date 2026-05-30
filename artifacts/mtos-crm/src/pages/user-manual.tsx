import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download } from "lucide-react";
import manual from "@/content/user-manual.md?raw";
import { Button } from "@/components/ui/button";

function downloadManual() {
  const blob = new Blob([manual], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "Mass-Tort-OS-User-Manual.md";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function UserManualPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-end">
        <Button onClick={downloadManual} variant="outline" size="sm">
          <Download className="mr-2 h-4 w-4" />
          Download manual
        </Button>
      </div>
      <article
        className="prose prose-sm dark:prose-invert max-w-none
          prose-headings:scroll-mt-20
          prose-h1:text-3xl prose-h1:font-bold prose-h1:mt-0
          prose-h2:mt-10 prose-h2:border-b prose-h2:pb-2
          prose-h3:mt-6
          prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5
          prose-code:before:content-none prose-code:after:content-none
          prose-a:text-primary"
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{manual}</ReactMarkdown>
      </article>
    </div>
  );
}
