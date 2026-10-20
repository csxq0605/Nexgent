/**
 * The `todo_write` tool (K2): the model keeps the plan of a multi-step task
 * as a checklist the user sees. Name, schema and effects are frozen in
 * `TODO_WRITE_TOOL`; the description is ours.
 */
import { NexgentError, renderTodoList, TODO_LIMITS, TODO_STATUSES, TODO_WRITE_TOOL, type Tool, type TodoItem, type TodoList } from '@nexgent/kernel'

/** Model-facing description of `todo_write`. */
export const TODO_WRITE_DESCRIPTION = 'Keep the plan of a multi-step task as a checklist the user can see. '
  + 'Each call replaces the whole list; mark an item in_progress when you start it and done when it is finished. Skip it for simple tasks.'

function parse(input: unknown): TodoList {
  const todos = (input as { todos?: unknown } | null)?.todos
  if (!Array.isArray(todos) || todos.length > TODO_LIMITS.maxItems) throw new NexgentError('tool/invalid-input', `todos must be a list of at most ${TODO_LIMITS.maxItems} items`)
  const items: TodoItem[] = todos.map((raw: unknown, index) => {
    const item = raw as { text?: unknown; status?: unknown } | null
    const text = typeof item?.text === 'string' ? item.text.trim() : ''
    if (text === '' || text.length > TODO_LIMITS.maxTextChars) throw new NexgentError('tool/invalid-input', `todos[${index}].text must be 1–${TODO_LIMITS.maxTextChars} characters`)
    if (!TODO_STATUSES.includes(item!.status as TodoItem['status'])) throw new NexgentError('tool/invalid-input', `todos[${index}].status must be one of ${TODO_STATUSES.join(', ')}`)
    return { text, status: item!.status as TodoItem['status'] }
  })
  return { todos: items }
}

/** Build the `todo_write` tool. Stateless: the latest list is the last result's `meta`. */
export function todoWriteTool(): Tool {
  return {
    definition: {
      name: TODO_WRITE_TOOL.name,
      description: TODO_WRITE_DESCRIPTION,
      inputSchema: TODO_WRITE_TOOL.inputSchema,
      effects: TODO_WRITE_TOOL.effects,
      approval: TODO_WRITE_TOOL.approval,
    },
    async handler(input) {
      const list = parse(input)
      return { content: renderTodoList(list), meta: { todos: list.todos.map(item => ({ ...item })) } }
    },
  }
}
