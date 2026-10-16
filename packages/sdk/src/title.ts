/**
 * Rework D2 (ui-redesign-research §6 item 7): a short title for a
 * conversation, named by the execution model after the first turn instead of
 * cutting the first sentence (several conversations then share one title).
 * One request without tools or thinking, recorded in the ledger like any
 * other (`purpose: 'auxiliary'`, the session's id).
 */
import { randomUUID } from 'node:crypto'
import { SESSION_TITLE_PROMPT, type LLMCompleteOptions, type LLMProvider } from '@nexgent/kernel'

/** Longest title kept, in characters (a sidebar row shows about this much). */
export const TITLE_MAX_CHARS = 40
/** Output budget of the title request; a title needs a few dozen tokens. */
const TITLE_MAX_TOKENS = 60
/** How much of the first message the model sees. */
const MESSAGE_MAX_CHARS = 2_000

/** What {@link nameConversation} needs. */
export interface TitleInput {
  readonly llm: LLMProvider
  readonly model: string
  readonly sessionId: string
  /** The first message the user typed. */
  readonly message: string
  readonly signal?: AbortSignal
}

/** Clean a model reply into a title: first non-empty line, no quotes, labels or closing punctuation; `undefined` when nothing is left. */
export function cleanTitle(reply: string): string | undefined {
  const line = reply.split(/\r?\n/).map(part => part.trim()).find(part => part !== '')
  if (line === undefined) return undefined
  let title = line.replace(/^(title|标题)\s*[:：]\s*/i, '').replace(/\s+/g, ' ')
  // Quotes and closing punctuation, in either order ("…". or “…”。).
  for (let before = ''; before !== title;) {
    before = title
    title = title.replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g, '').replace(/[。.!！?？,，;；:：]+$/u, '').trim()
  }
  if ([...title].length > TITLE_MAX_CHARS) title = `${[...title].slice(0, TITLE_MAX_CHARS - 1).join('')}…`
  return title === '' ? undefined : title
}

/** Ask the model for a title; `undefined` when the request failed or the reply was empty (the list then keeps the first message). */
export async function nameConversation(input: TitleInput): Promise<string | undefined> {
  const message = input.message.trim()
  if (message === '') return undefined
  const options: LLMCompleteOptions = { sessionId: input.sessionId, purpose: 'auxiliary' }
  let text = ''
  let failed = false
  for await (const event of input.llm.complete({
    requestId: randomUUID(),
    model: input.model,
    thinking: 'off',
    maxTokens: TITLE_MAX_TOKENS,
    messages: [
      { role: 'system', content: SESSION_TITLE_PROMPT },
      { role: 'user', content: message.slice(0, MESSAGE_MAX_CHARS) },
    ],
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }, options)) {
    if (event.type === 'text.delta') text += event.text
    else if (event.type === 'error') failed = true
  }
  return failed ? undefined : cleanTitle(text)
}
