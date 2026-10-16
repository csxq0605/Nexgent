/**
 * The D11–D14 judges of accept-step3: each decides one desktop item from the
 * observations step3-desktop.mjs collected. Pure, like the H judges, so each
 * is tested against a broken copy of a real run
 * (packages/test-support/tests/accept-step3-desktop.spec.ts).
 */
import { MEMBER_FILES, MEMBER_TEXTS } from './step3-desktop.mjs'
import { verdict } from './step2-judges.mjs'

/** The approval dialog's member line (apps/desktop: `成员 <name>（<form>）请求这一操作`). */
export const WRITER_APPROVAL_LINE = '成员 writer（委派）请求这一操作'

const blockOf = (blocks, name) => (Array.isArray(blocks) ? blocks.find(b => b?.member === name) : undefined)
const consoleErrors = obs => [...(obs.consoleErrors?.first ?? []), ...(obs.consoleErrors?.second ?? [])]

function withScenario(obs, result) {
  if (result.status !== 'failed' || obs.error === undefined) return result
  return { ...result, evidence: `${result.evidence} (members scenario stopped at ${obs.error.step}: ${String(obs.error.message).split('\n')[0]})` }
}

export const MEMBER_JUDGES = {
  D11(obs) {
    const running = blockOf(obs.running?.blocks, 'writer')
    const done = blockOf(obs.finished?.blocks, 'writer')
    const links = obs.finished?.deliverableLinks ?? []
    return verdict([
      [running?.status === 'running', `while the member runs its block shows writer, running (got ${JSON.stringify(running)})`],
      [done?.status === 'completed', `after it ends the block reads completed (got ${JSON.stringify(done)})`],
      [links.length === 1 && links[0].includes(`${MEMBER_FILES.north.path} · 第 1 版`), `the finished block links the member's deliverable ${MEMBER_FILES.north.path} v1 (got ${JSON.stringify(links)})`],
      [obs.finished?.toolBlocks === 1, `the member's own tool calls stay out of the main conversation: one tool block, the delegate call (got ${obs.finished?.toolBlocks})`],
      [consoleErrors(obs).length === 0, `no renderer console errors (got ${consoleErrors(obs).slice(0, 3).join(' | ')})`],
    ], 'a member block (name, status) appears in the middle column while the member runs and links its deliverable once it ends')
  },

  D12(obs) {
    const v = obs.view ?? {}
    return verdict([
      [v.title === '成员 writer 的会话', `the block opens the member's session (title ${JSON.stringify(v.title)})`],
      [typeof v.text === 'string' && v.text.includes(MEMBER_TEXTS.writerDone), "the view shows the member's own conversation"],
      [v.deliverableCards === 1, `the member's deliverable card is in its view (got ${v.deliverableCards})`],
      [v.composerWhileOpen === 0, `read-only: no composer while the member view is open (got ${v.composerWhileOpen})`],
      [v.back === true, 'the back button returns to the main conversation (composer back)'],
      [typeof v.sessionItem === 'string' && v.sessionItem.includes('1 个成员'), `the sidebar counts the member under its parent session (got ${JSON.stringify(v.sessionItem)})`],
    ], "clicking the member block opens the member's session read-only; back returns to the conversation")
  },

  D13(obs) {
    const a = obs.approval ?? {}
    return verdict([
      [a.memberLine === WRITER_APPROVAL_LINE, `the approval dialog names the member: ${JSON.stringify(a.memberLine)}`],
      [blockOf(a.blocksWhileAsking, 'writer')?.status === 'running', 'the member block stays running while the dialog asks'],
      [a.envBefore === null, `${MEMBER_FILES.env.path} did not exist before the choice`],
      [a.dialogGone === true && a.envAfter === MEMBER_FILES.env.content, `after "allow once" the dialog closed and the member's write landed (got ${JSON.stringify(a.envAfter)})`],
      [typeof a.rootReply === 'string' && a.rootReply.includes(MEMBER_TEXTS.rootDone), 'the member finished and the main conversation continued'],
    ], 'the member-raised approval dialog shows the member name; after the choice the member and the conversation continue')
  },

  D14(obs) {
    const r = obs.restart ?? {}
    const slowBefore = blockOf(obs.kill?.blocksBeforeKill, 'slow')
    const slow = blockOf(r.blocks, 'slow')
    const writer = blockOf(r.blocks, 'writer')
    return verdict([
      [slowBefore?.status === 'running' && (obs.kill?.chunksBeforeKill ?? 0) > 5, 'the main process was hard-killed while the second member streamed'],
      [r.sessions === 1 && typeof r.sessionItem === 'string' && r.sessionItem.includes('2 个成员'), `after restart one session with two members (got ${r.sessions}, ${JSON.stringify(r.sessionItem)})`],
      [Array.isArray(r.blocks) && r.blocks.length === 2, `both member blocks are back (got ${JSON.stringify(r.blocks)})`],
      [writer?.status === 'completed', `writer still reads completed (got ${writer?.status})`],
      [slow?.status === 'interrupted' && slow?.label === '已中断', `the killed member reads 已中断 (got ${JSON.stringify(slow)})`],
      [(r.deliverableLinks ?? []).some(l => l.includes(`${MEMBER_FILES.north.path} · 第 1 版`)), `the member's deliverable link is still there (got ${JSON.stringify(r.deliverableLinks)})`],
      [r.writerView?.title === '成员 writer 的会话' && r.writerView?.deliverableCards === 1, "writer's session still opens with its deliverable"],
      [r.slowView?.title === '成员 slow 的会话' && typeof r.slowView?.text === 'string' && r.slowView.text.includes(MEMBER_TEXTS.slowTask), "the killed member's session still opens with its task"],
      [consoleErrors(obs).length === 0, `no renderer console errors (got ${consoleErrors(obs).slice(0, 3).join(' | ')})`],
    ], 'after a hard kill and restart the member blocks, member sessions and member deliverables are all still there')
  },
}

/**
 * Judge one of D11–D14 from the members observations; a throw is a failure, never a pass.
 * @returns `{ status, evidence }`.
 */
export function judgeMembers(id, obs) {
  const fn = MEMBER_JUDGES[id]
  if (fn === undefined) return { status: 'not-implemented', evidence: 'no judge' }
  try {
    return withScenario(obs ?? {}, fn(obs ?? {}))
  } catch (error) {
    return { status: 'failed', evidence: `judge threw: ${error instanceof Error ? error.message : String(error)}` }
  }
}
