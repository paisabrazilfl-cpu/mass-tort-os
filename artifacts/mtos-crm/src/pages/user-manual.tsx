import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import manual from "@/content/user-manual.md?raw";

export default function UserManualPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
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
