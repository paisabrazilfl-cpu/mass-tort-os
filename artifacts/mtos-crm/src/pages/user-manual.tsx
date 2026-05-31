import { useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download, FileDown } from "lucide-react";
import manual from "@/content/user-manual.md?raw";
import { Button } from "@/components/ui/button";

const PDF_TITLE = "Mass Tort OS — User Manual";

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

// Print-only stylesheet for the PDF export. Kept self-contained (no app theme
// tokens) so the printed document is legible black-on-white regardless of the
// in-app light/dark theme.
const PRINT_CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #111;
    line-height: 1.5;
    font-size: 11px;
    margin: 0;
  }
  h1 { font-size: 22px; font-weight: 700; margin: 0 0 12px; }
  h2 { font-size: 17px; font-weight: 700; margin: 22px 0 8px; border-bottom: 1px solid #ccc; padding-bottom: 4px; page-break-after: avoid; }
  h3 { font-size: 14px; font-weight: 700; margin: 16px 0 6px; page-break-after: avoid; }
  h4, h5, h6 { font-size: 12px; font-weight: 700; margin: 12px 0 6px; page-break-after: avoid; }
  p { margin: 6px 0; }
  ul, ol { margin: 6px 0; padding-left: 20px; }
  li { margin: 2px 0; }
  a { color: #1a4ed8; text-decoration: none; word-break: break-word; }
  hr { border: 0; border-top: 1px solid #ddd; margin: 16px 0; }
  blockquote { margin: 8px 0; padding: 4px 12px; border-left: 3px solid #bbb; color: #333; background: #f7f7f7; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10px; background: #f0f0f0; padding: 1px 4px; border-radius: 3px; }
  pre { background: #f5f5f5; padding: 10px; border-radius: 4px; overflow: hidden; white-space: pre-wrap; word-break: break-word; page-break-inside: avoid; }
  pre code { background: none; padding: 0; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 10px; page-break-inside: avoid; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; font-weight: 700; }
  tr { page-break-inside: avoid; }
`;

function downloadPdf(sourceHtml: string) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) {
    document.body.removeChild(iframe);
    return;
  }

  doc.open();
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${PDF_TITLE}</title><style>${PRINT_CSS}</style></head><body>${sourceHtml}</body></html>`,
  );
  doc.close();

  const cleanup = () => {
    if (iframe.parentNode) {
      iframe.parentNode.removeChild(iframe);
    }
  };

  const trigger = () => {
    try {
      win.focus();
      win.print();
    } finally {
      // Give the print dialog time to read the document before removing it.
      window.setTimeout(cleanup, 1000);
    }
  };

  if (doc.readyState === "complete") {
    window.setTimeout(trigger, 50);
  } else {
    iframe.onload = () => window.setTimeout(trigger, 50);
  }
}

export default function UserManualPage() {
  const articleRef = useRef<HTMLElement>(null);

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-end gap-2">
        <Button onClick={downloadManual} variant="outline" size="sm">
          <Download className="mr-2 h-4 w-4" />
          Download manual
        </Button>
        <Button
          onClick={() => {
            const html = articleRef.current?.innerHTML;
            if (html) downloadPdf(html);
          }}
          variant="outline"
          size="sm"
        >
          <FileDown className="mr-2 h-4 w-4" />
          Download PDF
        </Button>
      </div>
      <article
        ref={articleRef}
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
