import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

interface MarkdownContentProps {
  markdown: string;
  className?: string;
}

export function MarkdownContent(props: MarkdownContentProps): JSX.Element {
  const { markdown, className } = props;
  const html = useMemo(() => {
    const parsed = marked.parse(markdown, { async: false });
    return DOMPurify.sanitize(typeof parsed === "string" ? parsed : "");
  }, [markdown]);

  return (
    <div
      className={`markdown-body${className ? ` ${className}` : ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
