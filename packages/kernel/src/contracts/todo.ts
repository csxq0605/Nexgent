/**
 * K2 (audit P28): `todo_write`, the visible plan of a multi-step task. Each
 * call replaces the whole list; the tool result's `meta.todos` carries it,
 * so the session history (and the desktop's process view) always shows the
 * latest plan. Bookkeeping only: it changes no file.
 *
 * Normative text: `docs/spec/agent-hooks.md` §工具清单.
 */
import type { JsonSchema } from './json.js'
import type { Step2ToolSpec } from './step2-tools.js'

/** State of one plan item. */
export type TodoStatus = 'pending' | 'in_progress' | 'done'

/** Every {@link TodoStatus}. */
export const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'done']

/** One plan item. */
export interface TodoItem {
  readonly text: string
  readonly status: TodoStatus
}

/** `todo_write` arguments and the `meta` of its result. */
export interface TodoList {
  readonly todos: readonly TodoItem[]
}

/** Bounds of a list. */
export const TODO_LIMITS = { maxItems: 30, maxTextChars: 200 } as const

/** `todo_write`. */
export const TODO_WRITE_TOOL: Step2ToolSpec = {
  name: 'todo_write',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['todos'],
    properties: {
      todos: {
        type: 'array',
        maxItems: TODO_LIMITS.maxItems,
        description: 'The whole plan, in order; replaces the previous list.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'status'],
          properties: {
            text: { type: 'string', minLength: 1, maxLength: TODO_LIMITS.maxTextChars } satisfies JsonSchema,
            status: { enum: [...TODO_STATUSES] },
          },
        },
      },
    },
  },
}

/** The tool result text (pure): one line per item with a box for its state. */
export function renderTodoList(list: TodoList): string {
  if (list.todos.length === 0) return 'The plan is empty.'
  const box: Record<TodoStatus, string> = { pending: '[ ]', in_progress: '[~]', done: '[x]' }
  return list.todos.map(item => `${box[item.status]} ${item.text}`).join('\n')
}

/** The latest list among `todo_write` results' `meta` values, oldest first; `undefined` when none (pure). */
export function latestTodoList(metas: readonly unknown[]): TodoList | undefined {
  for (let index = metas.length - 1; index >= 0; index--) {
    const meta = metas[index]
    if (meta !== null && typeof meta === 'object' && Array.isArray((meta as { todos?: unknown }).todos)) return meta as TodoList
  }
  return undefined
}
