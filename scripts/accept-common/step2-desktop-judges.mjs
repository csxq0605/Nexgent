/**
 * The D judges of accept-step2: each decides one desktop checklist item from
 * the observations step2-desktop.mjs collected. Pure, like the H judges, so
 * each is tested against a broken copy of a real run
 * (packages/test-support/tests/accept-step2-judges.spec.ts).
 */
import { ENV_CONTENT, LONG_TEXT, SETTINGS, TEXTS } from './step2-desktop.mjs'
import { verdict } from './step2-judges.mjs'

const ISOLATION = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const denied = (result, check) => result?.ok === false && result?.error?.code === 'approval/denied' && result?.error?.details?.check === check

/** Add the scenario's stop point to a failing judge's evidence. */
function withScenario(obs, result) {
  if (result.status !== 'failed' || obs.error === undefined) return result
  return { ...result, evidence: `${result.evidence} (scenario stopped at ${obs.error.step}: ${String(obs.error.message).split('\n')[0]})` }
}

export const DESKTOP_JUDGES = {
  D01(obs) {
    const w = obs.window ?? {}
    const errors = [...(obs.consoleErrors?.first ?? []), ...(obs.consoleErrors?.second ?? [])]
    const wrongPrefs = Object.entries(ISOLATION).filter(([key, value]) => w.prefs?.[key] !== value).map(([key]) => `${key}=${w.prefs?.[key]}`)
    return verdict([
      [w.url === 'app://nexgent/index.html', `window loads app://nexgent/index.html (got ${w.url})`],
      [w.startScreen === true, 'the renderer shows the start screen'],
      [w.prefs !== undefined && wrongPrefs.length === 0, `webPreferences isolated (${wrongPrefs.join(', ') || 'not read'})`],
      [w.spellcheck === false, 'spellchecker off'],
      [same(w.pageGlobals, ['undefined', 'undefined']), `page has no require / process (got ${JSON.stringify(w.pageGlobals)})`],
      [same(w.bridgeKeys, ['invoke', 'onEvent', 'platform']), `bridge exposes only invoke, onEvent, platform (got ${JSON.stringify(w.bridgeKeys)})`],
      [obs.restart?.reopened === true, 'the scenario reached the second launch (console watched in both runs)'],
      [errors.length === 0, `no renderer console errors (got ${errors.slice(0, 3).join(' | ')})`],
    ], 'window app://nexgent/index.html, isolated webPreferences, no Node in the page, bridge of three members, no console errors in either launch')
  },

  D02(obs) {
    return verdict([
      [obs.project?.created === true && obs.project?.config?.version === 1, 'project created from the start screen; .nexgent/config.json version 1'],
      [obs.restart?.reopened === true && obs.restart?.sessions === 1, 'after restart the workspace reopens the project by itself with its session'],
      [Array.isArray(obs.restart?.recent) && obs.restart.recent[0] === obs.projectRoot, 'projects.recent lists the project first'],
    ], 'new project created in the UI; reopened from the recent list after restart')
  },

  D03(obs) {
    const m = obs.materials ?? {}
    return verdict([
      [m.count === 2, `two material items in the right column (got ${m.count})`],
      [String(m.listText ?? '').includes('orders.csv') && String(m.listText ?? '').includes('regions.xlsx'), 'the list names orders.csv and regions.xlsx'],
      [m.onDisk === 2, `two material directories under .nexgent/materials (got ${m.onDisk})`],
    ], 'two materials (.csv, .xlsx) added; right column and .nexgent/materials both show two (added by path: the app has no file dialog yet)')
  },

  D04(obs) {
    const s = obs.stream ?? {}
    return verdict([
      [typeof s.partialText === 'string' && s.partialText.length > 0 && !s.partialText.includes(TEXTS.firstTurn), `an assistant message was seen streaming before the reply was complete (saw ${JSON.stringify(s.partialText)})`],
      [String(s.finalText ?? '').includes(TEXTS.firstTurn), 'the streamed reply completes in the timeline'],
      [s.toolBlocksDuringTurn >= 1, 'tool activity blocks appear'],
      [String(s.userMessage ?? '').includes('@orders.csv'), 'the user message shows the @ mention'],
      [s.firstRequestMentionsBoth === true, 'the first request references both materials'],
    ], `streaming text seen (${JSON.stringify(s.partialText)}) then completed; ${s.toolBlocksDuringTurn} tool block(s)`)
  },

  D05(obs) {
    const a = obs.approval ?? {}
    return verdict([
      [a.dialogShown === true && a.envBefore === false, 'approval dialog shown before .env exists'],
      [a.dialogGone === true, 'the dialog closes after allowing once'],
      [a.envAfter === ENV_CONTENT, '.env written after approval'],
      [a.toolBlocks === 3, `the turn continues: three tool blocks (got ${a.toolBlocks})`],
      [same(a.turnEnds, ['completed']), `turn 1 ends completed (got ${JSON.stringify(a.turnEnds)})`],
    ], 'approval dialog for .env; allowed once; the turn continued to present and completed')
  },

  D06(obs) {
    const d = obs.deliverable ?? {}
    return verdict([
      [d.cardsAfterFirst === 1, `a deliverable card after turn 1 (got ${d.cardsAfterFirst})`],
      [String(d.v1Content ?? '').includes('north,1200'), 'the viewer shows v1'],
      [same(d.feedback, [{ version: 1, rating: 3 }]), `one feedback record, rating 3 on v1 (got ${JSON.stringify(d.feedback)})`],
      [d.cardsAfterFeedback === 2 && same(d.versions, [1, 2]), `v2 presented after feedback (cards ${d.cardsAfterFeedback}, versions ${JSON.stringify(d.versions)})`],
      [String(d.diffText ?? '').includes('v1 → v2'), 'diff view labelled v1 → v2'],
      [same(d.removed, ['-north,1200']) && same(d.added, ['+华北,1200']), `diff shows exactly the change (removed ${JSON.stringify(d.removed)}, added ${JSON.stringify(d.added)})`],
      [d.items === 1, 'one deliverable in the right column'],
    ], 'deliverable card; feedback from the card produced v2; diff v1 → v2 shows -north,1200 / +华北,1200')
  },

  D07(obs) {
    const s = obs.stop ?? {}
    const head = LONG_TEXT.slice(0, 3).join('')
    const interrupted = s.interrupted ?? []
    return verdict([
      [s.turnEndLabel === '已停止', `the turn ends as stopped (got ${JSON.stringify(s.turnEndLabel)})`],
      [String(s.kept ?? '').includes(head) && String(s.kept ?? '').includes('已中断'), 'the streamed text stays in the UI, marked interrupted'],
      [!String(s.kept ?? '').includes(LONG_TEXT.at(-1)), 'the stream was cut before its end'],
      [interrupted.length === 1 && interrupted[0].includes(head) && String(s.kept ?? '').includes(interrupted[0]), 'the session keeps the same text as an interrupted assistant.message'],
      [same(s.turnEnds, ['completed', 'completed', 'cancelled']), `turn.end kinds completed, completed, cancelled (got ${JSON.stringify(s.turnEnds)})`],
    ], 'stop cancelled the turn; streamed text kept in the UI and in session.jsonl')
  },

  D08(obs) {
    const k = obs.kill ?? {}
    const r = obs.restart ?? {}
    return verdict([
      [String(k.streamedBeforeKill ?? '').includes(TEXTS.killStream) && k.runningBeforeKill === true, 'the main process was killed while a turn was streaming'],
      [r.turnEndLabel === '上次运行被中断（应用曾意外退出）', 'after restart the killed turn shows as interrupted'],
      [r.materials === 2 && r.cards === 2, `materials and deliverables are back (materials ${r.materials}, cards ${r.cards})`],
      [String(r.continued ?? '').includes(TEXTS.continued), 'continuing the conversation succeeds'],
      [same(r.turnEnds, ['completed', 'completed', 'cancelled', 'interrupted', 'completed']), `turn.end kinds after restart (got ${JSON.stringify(r.turnEnds)})`],
      [r.scriptConsumed === true, `every scripted reply was used (${r.scriptError ?? 'ok'})`],
    ], 'killed mid-stream; restart shows conversation, two materials, two deliverable cards; the next turn completed')
  },

  D09(obs) {
    const s = obs.settings ?? {}
    const c = s.config ?? {}
    return verdict([
      [c.model === SETTINGS.model && c.thinking === SETTINGS.thinking, `config.json model / thinking (got ${c.model} / ${c.thinking})`],
      [c.costCaps?.perTask?.maxTokens === SETTINGS.perTaskTokens && c.costCaps?.perProject?.maxRequests === SETTINGS.perProjectRequests, 'config.json cost caps'],
      [s.keyStatus === '已配置（来源：环境变量）', `key shown only as configured and its source (got ${JSON.stringify(s.keyStatus)})`],
      [s.pageHasKey === false && s.configHasKey === false, 'the key value is in neither the page nor config.json'],
    ], `settings saved to config.json (model ${c.model}, thinking ${c.thinking}, caps); key shown as source only`)
  },

  D10(obs) {
    const i = obs.ipc ?? {}
    return verdict([
      [denied(i.missing, 'token'), 'a call without a token is denied (check token)'],
      [denied(i.wrong, 'token'), 'a call with a wrong token is denied'],
      [denied(i.empty, 'token'), 'a call with an empty token is denied'],
      [i.unlisted?.code === 'approval/denied' && i.unlisted?.details?.check === 'method', 'an unlisted method from the page is denied (check method)'],
      [Array.isArray(i.valid), 'the page’s own call with its token still works'],
      [i.loggedTokenDenials === 3 && i.logHasToken === false, `three token denials logged, no token in the log (got ${i.loggedTokenDenials})`],
    ], 'missing / wrong / empty token denied and logged without the token; unlisted method denied; valid call answered')
  },
}

/**
 * Judge one desktop item; a throw is a failure, never a pass.
 * @returns `{ status, evidence }`.
 */
export function judgeDesktop(id, obs) {
  const fn = DESKTOP_JUDGES[id]
  if (fn === undefined) return { status: 'not-implemented', evidence: 'no judge' }
  try {
    return withScenario(obs ?? {}, fn(obs ?? {}))
  } catch (error) {
    return { status: 'failed', evidence: `judge threw: ${error instanceof Error ? error.message : String(error)}` }
  }
}
