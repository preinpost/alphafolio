import { memo } from "react";
import ReactMarkdown from "react-markdown";
import { remarkPlugins } from "../lib/markdown.ts";

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    // 색은 styles.css 의 .prose 가 토큰으로 준다 (라이트·다크 자동) — prose-neutral·prose-invert 를 쓰지 않는다
    <div className="prose max-w-none text-[15px] prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:my-2">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={{
          table: ({ node: _node, ...props }) => (
            <div className="md-table">
              <table {...props} />
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
