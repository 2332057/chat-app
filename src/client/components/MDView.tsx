import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';

import 'highlight.js/styles/github-dark.css';

export function MDView({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[
          [rehypeHighlight, { detect: true }]
        ]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
