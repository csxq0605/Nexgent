/** K2: `todo_write` keeps the visible plan; each call replaces the list, the result's meta carries it. */
import { latestTodoList, TODO_WRITE_TOOL, type ToolContext } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import { todoWriteTool } from '../src/index.js'

const context = {} as ToolContext

describe('todo_write', () => {
  it('replaces the plan, renders it and carries it in meta', async () => {
    const tool = todoWriteTool()
    expect(tool.definition).toMatchObject({ name: TODO_WRITE_TOOL.name, effects: ['read'], approval: 'never' })
    const first = await tool.handler({ todos: [{ text: 'Read the parser', status: 'in_progress' }, { text: 'Fix the bug', status: 'pending' }] }, context)
    expect(first.content).toBe('[~] Read the parser\n[ ] Fix the bug')
    const second = await tool.handler({ todos: [{ text: 'Read the parser', status: 'done' }, { text: 'Fix the bug', status: 'in_progress' }] }, context)
    expect(latestTodoList([first.meta, { other: 1 }, second.meta])).toEqual({ todos: [{ text: 'Read the parser', status: 'done' }, { text: 'Fix the bug', status: 'in_progress' }] })
    expect((await tool.handler({ todos: [] }, context)).content).toBe('The plan is empty.')
  })

  it('refuses a malformed list', async () => {
    const tool = todoWriteTool()
    await expect(tool.handler({ todos: [{ text: '', status: 'pending' }] }, context)).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(tool.handler({ todos: [{ text: 'x', status: 'started' }] }, context)).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(tool.handler({ todos: Array.from({ length: 31 }, () => ({ text: 'x', status: 'pending' })) }, context)).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })
})
