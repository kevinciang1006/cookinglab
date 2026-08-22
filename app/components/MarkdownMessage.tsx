"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// ---------------------------------------------------------------------------
// Renders assistant/answer text as real markdown — headings, ingredient
// tables, numbered steps, bold/italic, blockquote callouts — styled to the
// app's warm lab theme. Replaces renderMarkdownLite (bold/italic only) for
// anything long/structured enough to need it: chat answers and dish-page
// answers. User message bubbles stay plain text — this is assistant-only.
// ---------------------------------------------------------------------------

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mt-6 mb-3 text-2xl font-semibold tracking-tight text-ink first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-6 mb-2 border-b border-hairline pb-1.5 text-xl font-semibold tracking-tight text-ink first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-1.5 text-lg font-semibold text-ink first:mt-0">{children}</h3>
  ),
  p: ({ children }) => <p className="mb-3 leading-relaxed text-ink last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="text-ink">{children}</em>,
  del: ({ children }) => <del className="text-ink-muted line-through">{children}</del>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent underline decoration-dotted underline-offset-2"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-5 border-hairline" />,
  // Blockquotes are the callout vehicle for "your own logged learnings" the
  // ANSWER prompt is instructed to weave in (e.g. a rubbery-fish timing
  // fix) — an accent-bordered aside, distinct from the surrounding recipe.
  blockquote: ({ children }) => (
    <blockquote className="my-4 rounded-r-lg border-l-[3px] border-accent bg-accent-soft/50 py-2 pl-4 pr-3 text-ink [&>p]:mb-0">
      {children}
    </blockquote>
  ),
  ul: ({ children }) => (
    <ul className="mb-3 list-disc space-y-1.5 pl-5 marker:text-accent last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 list-decimal space-y-2 pl-5 marker:font-semibold marker:text-accent last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1 leading-relaxed text-ink">{children}</li>,
  code: ({ children, className }) => {
    // Fenced code blocks carry a language-* className from remark; inline
    // code doesn't — that's the cleanest signal to tell them apart here.
    if (className) {
      return (
        <code className="block overflow-x-auto whitespace-pre rounded-lg border border-hairline bg-paper p-3 font-mono text-xs text-ink">
          {children}
        </code>
      );
    }
    return (
      <code className="whitespace-normal break-words rounded bg-paper px-1.5 py-0.5 font-mono text-[0.85em] text-ink">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <pre className="mb-3 overflow-x-auto last:mb-0">{children}</pre>,
  // Ingredient tables must look good: bordered, scrollable on mobile
  // (the wrapper, not the table itself, owns the horizontal scroll so the
  // card never causes the whole page to scroll sideways).
  table: ({ children }) => (
    <div className="mb-4 overflow-x-auto rounded-xl border border-hairline last:mb-0">
      <table className="w-full min-w-[22rem] border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-paper">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-hairline px-3 py-2 text-left font-mono text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-hairline px-3 py-2 align-top text-ink">{children}</td>
  ),
  tr: ({ children }) => <tr className="last-of-type:[&>td]:border-b-0">{children}</tr>,
  input: ({ checked }) => (
    <input
      type="checkbox"
      checked={Boolean(checked)}
      disabled
      readOnly
      className="mr-2 h-4 w-4 accent-accent align-middle"
    />
  ),
};

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="min-w-0 overflow-x-hidden break-words text-base">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
