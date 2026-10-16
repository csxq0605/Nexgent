import ReactMarkdown, { type Components } from 'react-markdown'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'
import { T } from '../strings.js'

/*
 * Model replies are Markdown (GFM: tables, task lists, strikethrough). Raw
 * HTML in the text is dropped, never rendered. Links do not navigate (the
 * main process refuses every navigation anyway): they show their target on
 * hover. Images are not fetched; their alt text stands in. Emphasis next to
 * CJK text and punctuation (`**合计：**12 单`) is bold too, which plain
 * CommonMark refuses (remark-cjk-friendly).
 */
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} title={href} onClick={event => event.preventDefault()}>
      {children}
    </a>
  ),
  img: ({ alt, src }) => <span title={typeof src === 'string' ? src : undefined}>{`[${alt === undefined || alt === '' ? T.image : alt}]`}</span>,
}

const PLUGINS = [remarkGfm, remarkCjkFriendly]

export function Markdown({ text }: { readonly text: string }): JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  )
}
