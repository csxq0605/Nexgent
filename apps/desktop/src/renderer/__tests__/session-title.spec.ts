import { describe, expect, it } from 'vitest'
import { sessionTitle, T } from '../strings.js'

describe('sessionTitle', () => {
  it('prefers the title, then the goal, then the first prompt the list carries, then the open session\'s first message', () => {
    expect(sessionTitle({ title: '六月汇总', goal: { text: '目标' }, firstMessage: '提示' })).toBe('六月汇总')
    expect(sessionTitle({ goal: { text: '目标' }, firstMessage: '提示' })).toBe('目标')
    expect(sessionTitle({ firstMessage: '汇总九月订单\n按地区' }, '打开时的消息')).toBe('汇总九月订单')
    expect(sessionTitle({}, '打开时的消息')).toBe('打开时的消息')
    expect(sessionTitle({})).toBe(T.untitled)
  })
})
