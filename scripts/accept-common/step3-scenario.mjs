/**
 * The step-3 acceptance scenario for the scripted model server, as data plus
 * request-aware entries (docs/plan/step-3-work-partition.md §`accept-step3`
 * 检查项清单). Requests are routed per session (test-support `routeByMember`):
 * the root session answers from `lead`, each member from its own queue, keyed
 * by the `Member: <name> (<form>)` line of its system prompt.
 *
 * Phases:
 *   direct    one turn, no members: write_file → present → answer (H01, H10, H22)
 *   delegation project (one root session, one turn per phase):
 *     setup      a plain question/answer turn the fork must see and fresh must not
 *     fresh      delegate `analyst` (fresh, the stock.csv material) → it writes and
 *                presents analysis/summary.md → the root writes final/report.md and
 *                presents it with the analyst's file (H02, H04)
 *     fork       delegate `forker` (fork) → it answers from the copied history (H03)
 *     forkKill   in a child process: delegate `forker-two` (fork), whose reply stalls;
 *                the process is killed there (H03 recovery)
 *     resume     after the kill: a plain turn
 *     sameName   two delegates in one step, both present shared/notes.md (H16)
 *   read-only project (sandbox read-only, two project presets):
 *     readonly   delegate with preset `wide` (workspace-write: refused, no member),
 *                then `quiet` with preset `noshell` (denies the shell tool) (H12)
 *              then fetches the test page with the shipped `web_fetch` (loopback: refused) (H19)
 *   tools project (direct, workspace-write, test `web_fetch` row):
 *     ptc        run_code reads and writes project files and returns process.env; reads a
 *                file outside the project (refused); loops past its timeout (H17)
 *     sheet      load_skill spreadsheets (the tools are skill-gated), then write_spreadsheet with formulas, then external reference, unknown function,
 *                division by zero and too many sheets (each refused, nothing written) (H18)
 *     web        web_fetch of the local page (Markdown), of 127.0.0.1, of a private address
 *                and of a redirect to 127.0.0.1 (refused) (H19)
 *   workflow project:
 *     wfScript   five parallel members (cap 4 at a time) then a pipeline summariser that
 *                writes and presents final/summary.md (H07)
 *     wfGraph    a three-node graph, then a graph with a cycle (refused) (H08)
 *     wfKill     in a child process: `early` completes, `late` stalls; killed there (H09)
 *     wfResume   after the kill: a plain turn (no member may run again)
 *   team project:
 *     teamWork   three tasks (t3 depends on t1, t2); alice and bob work at once, each writes
 *                and presents a file; alice mails bob and the lead; bob tries t3 early (H05)
 *   team-kill project:
 *     teamKill   in a child process: bob finishes, alice claims t1 and mails bob and the lead;
 *                killed on alice's next request with both messages queued (H06)
 *     teamResume a fresh SDK: the lead lists the board and waits for the teammates
 *   cancel project (each turn cancelled by the caller while members run a slow command) (H13):
 *     cancelDelegate  a delegated member
 *     cancelTeam      two teammates
 *     cancelWorkflow  two workflow members in parallel
 *   budget project (costCaps.perTask maxRequests 2):
 *     budget     the root delegates `spender`, whose one request uses the last of the cap;
 *                the root's next request is blocked (H11)
 *   member-approval project (.env exists):
 *     memberApproval  delegate `keeper`, who edits .env (approval asked, denied) (H14)
 *   skills project (own home: one user-only skill, one name in user and project dirs):
 *     skills     load_skill of both names (H20)
 *   H15 reads the tool lists of every member request against the root's.
 *   H21 queries the delegation, workflow and team-kill projects through a fresh SDK.
 */

import { SLOW_COMMAND, shellCall } from './scenario-step2.mjs'

/** Fixed test key; the scripted server never checks it. */
export const SCRIPTED_API_KEY = 'nexgent-accept-step3-scripted-key'

/** Project files the scenario writes. */
export const FILES = {
  plan: { path: 'plan/restock.md', content: '# Restock plan\n\nP01: order 30 units.\n' },
  summary: { path: 'analysis/summary.md', content: '# Stock summary\n\nANALYST-SUMMARY-MARKER: 6 SKUs, 2 above target.\n' },
  report: { path: 'final/report.md', content: '# Final report\n\nBased on analysis/summary.md by the analyst.\n' },
  shared: { path: 'shared/notes.md', a: 'NOTES-FROM-A\n', b: 'NOTES-FROM-A\nNOTES-FROM-B\n' },
}

/** The material the fresh member receives by id. */
export const MATERIAL = { name: 'stock.csv', content: 'sku,on_hand\nP01,14\nP02,9\n' }

/** Text only the setup turn carries: a fork must see it, a fresh member must not. */
export const HISTORY_MARKER = 'PARENT-HISTORY-MARKER'

/** Text the forker-two reply streams before it stalls (the kill point). */
export const STALL_TEXT = 'Double-checking the supplier'

/** Project presets of the read-only project (`.nexgent/presets/<name>.json`). */
export function readonlyPresets() {
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
  return {
    shell,
    files: {
      wide: { formatVersion: 1, name: 'wide', description: 'Asks for a wider sandbox than the parent.', sandboxMode: 'workspace-write' },
      noshell: { formatVersion: 1, name: 'noshell', description: 'No shell tool.', tools: { deny: [shell] } },
    },
  }
}

/** Files of the tools project. */
export const TOOL_FILES = {
  input: { path: 'data/input.txt', content: 'restock p01 and p02\n' },
  output: 'data/output.txt',
  outside: 'outside-secret.txt',
  sheet: 'sheets/plan.xlsx',
  rejected: ['sheets/external.xlsx', 'sheets/unknown.xlsx', 'sheets/divzero.xlsx', 'sheets/too-many.xlsx'],
}

/** The spreadsheet the sheet phase writes: values plus formulas, and the cached values a correct writer computes. */
export const SHEET = {
  rows: [['SKU', 'Weekly', 'Weeks', 'Target'], ['P01', 8, 3, '=B2*C2'], ['P02', 5.5, 4, '=B3*C3'], ['Total', null, null, '=SUM(D2:D3)']],
  formulas: { D2: 'B2*C2', D3: 'B3*C3', D4: 'SUM(D2:D3)' },
  values: { D2: 24, D3: 22, D4: 46 },
}

/** Text of the local page (H19): a heading, a table and a hidden paragraph that must not survive. */
export const PAGE = {
  html: '<!doctype html><html><head><title>Stock page</title><style>p{}</style><script>var STOCK_SCRIPT=1</script></head><body><h1>Stock levels</h1><p>PAGE-BODY-MARKER</p><table><tr><th>SKU</th><th>On hand</th></tr><tr><td>P01</td><td>14</td></tr></table><p hidden>HIDDEN-MARKER</p></body></html>',
  heading: '# Stock levels',
  marker: 'PAGE-BODY-MARKER',
  hidden: ['HIDDEN-MARKER', 'STOCK_SCRIPT'],
}

/** Workflow members of the script phase. */
export const WF_PARTS = ['part-1', 'part-2', 'part-3', 'part-4', 'part-5']
/** The workflow member cap (README of @nexgent/workflow: at most 4 members run at once). */
export const WF_MAX_CONCURRENT = 4
/** Nodes of the three-node graph. */
export const WF_GRAPH = { nodes: [
  { id: 'gather', prompt: 'List the SKUs in one line.', dependencies: [] },
  { id: 'check', prompt: 'Check the list for duplicates.', dependencies: ['gather'] },
  { id: 'report', prompt: 'Report the result in one line.', dependencies: ['gather', 'check'] },
] }
/** A graph with a cycle (a → b → a). */
export const WF_CYCLE = { nodes: [
  { id: 'loop-a', prompt: 'A.', dependencies: ['loop-b'] },
  { id: 'loop-b', prompt: 'B.', dependencies: ['loop-a'] },
] }
/** Text the `late` member streams before it stalls (the workflow kill point). */
export const WF_STALL_TEXT = 'Late member is still counting'

/** Team messages (H05, H06). */
export const TEAM_TEXT = { toBob: 'a is ready', toLead: 'alice finished t1', killToBob: 'collected for bob', killToLead: 'collected for lead' }
/** Text the lead streams in the team kill phase before it stalls. */
export const TEAM_STALL_TEXT = 'Lead is thinking about the team'
/** Members of the cancel project, by turn. */
export const CANCEL_MEMBERS = { cancelDelegate: ['sleeper'], cancelTeam: ['mate-a', 'mate-b'], cancelWorkflow: ['flow-a', 'flow-b'] }

/** The budget project's cap (H11): the root's one request plus the member's one use it up. */
export const BUDGET = { perTask: { maxRequests: 2 } }
/** The `.env` of the member-approval project (H14) and the edit the member asks for. */
export const MEMBER_ENV = { path: '.env', original: 'TOKEN=keep-me\n', from: 'TOKEN=keep-me', to: 'TOKEN=member-wrote' }
/** Skill files of the skills project (H20): `user` only in the user directory, `shared` in both. */
export const SKILLS = {
  user: { name: 'restock-user', description: 'User-level restock checklist.', body: 'USER-ONLY-SKILL-BODY' },
  shared: {
    name: 'stock-format',
    user: { description: 'User copy of the stock format.', body: 'USER-SHARED-SKILL-BODY' },
    project: { description: 'Project copy of the stock format.', body: 'PROJECT-SHARED-SKILL-BODY' },
  },
}

/** Turn texts, used both as the user's message and to recognise requests. */
export const TASKS = {
  direct: 'Write a short restock plan into plan/restock.md and present it.',
  setup: `Remember this: the preferred supplier is ACME (${HISTORY_MARKER}).`,
  fresh: 'Have an analyst summarise the stock material, then present the final report.',
  fork: 'Ask a forked helper which supplier I prefer.',
  forkKill: 'Ask another forked helper to double-check the supplier.',
  resume: 'Continue after the crash: say where we are.',
  sameName: 'Have two writers each produce shared/notes.md.',
  readonly: 'Try a member with the wide preset, then one with the noshell preset.',
  ptc: 'Use run_code to upper-case data/input.txt, then try the limits.',
  sheet: 'Write the plan spreadsheet, then try the bad formulas.',
  web: 'Fetch the stock page and try the blocked addresses.',
  wfScript: 'Run a workflow: count the five parts in parallel, then summarise.',
  wfGraph: 'Run the three-step graph, then the looping one.',
  wfKill: 'Run the early-then-late workflow.',
  wfResume: 'Continue after the crash: where is the workflow?',
  teamWork: 'Write both parts with a team.',
  teamKill: 'Run the team.',
  teamResume: 'Carry on with the team.',
  cancelDelegate: 'Delegate a slow check.',
  cancelTeam: 'Have two teammates run slow checks.',
  cancelWorkflow: 'Run two slow checks in a workflow.',
  budget: 'Delegate the spending check.',
  memberApproval: 'Have a member store the token in .env.',
  skills: 'Load the restock skills.',
}

/** Member tasks (what the root passes to `delegate`). */
export const MEMBER_TASKS = {
  analyst: 'Summarise the stock material into analysis/summary.md and present it.',
  forker: 'Which supplier does the user prefer? Answer in one line.',
  forkerTwo: 'Double-check which supplier the user prefers.',
  writerA: 'Create shared/notes.md with your notes and present it.',
  writerB: 'Add your notes to shared/notes.md and present it.',
  wide: 'This member should never start.',
  quiet: 'Say which tools you have.',
  spender: 'Report the stock in one line.',
  keeper: 'Store the new token in .env.',
}

const usage = { inputTokens: 300, outputTokens: 30, totalTokens: 330, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

/**
 * Script entries per phase: `{ lead, routes }` for `scriptedModelServer`.
 * @param h - the loaded test-support harness.
 * @param state - filled by the scenario before the phases run: `materialId`, `pageUrl`,
 *   `loopbackUrl`, `redirectUrl`, `outsidePath`.
 */
export function buildStep3Script(h, state = {}) {
  const mentions = needle => body => h.requestText(body).includes(needle)
  const noMemberLine = body => !/^Member: /m.test(h.sessionText(body))
  /** The latest user turn of a request mentions `needle` (the turn being answered). */
  const turnOf = needle => (body) => {
    const users = (body?.messages ?? []).filter(message => message.role === 'user' && (typeof message.content === 'string' || (Array.isArray(message.content) && message.content.some(block => block?.type === 'text'))))
    return users.length > 0 && h.requestText({ messages: [users.at(-1)] }).includes(needle)
  }
  const member = name => body => h.sessionText(body).includes(`Member: ${name} (`)
  const delegate = (id, args) => ({ id, name: 'delegate', arguments: args })
  const answer = text => ({ content: text, usage })
  const call = (name, args, id) => ({ id, name, arguments: args })
  const calls = (...list) => ({ toolCalls: list, usage })
  const slow = turn => ({ ...turn, chunkDelayMs: 15 })
  return {
    direct: {
      lead: [
        h.expectRequest('direct turn (root session, no member line)', body => mentions(TASKS.direct)(body) && noMemberLine(body), {
          toolCalls: [{ name: 'write_file', arguments: { path: FILES.plan.path, content: FILES.plan.content } }],
          usage,
        }),
        h.expectRequest('write_file result', mentions(TASKS.direct), {
          toolCalls: [{ name: 'present', arguments: { paths: [FILES.plan.path], summary: 'Restock plan.' } }],
          usage,
        }),
        h.expectRequest('present result', mentions(TASKS.direct), { content: 'Plan presented.', usage }),
      ],
      routes: {},
    },
    delegation: {
      lead: [
        // setup
        h.expectRequest('setup turn', turnOf(HISTORY_MARKER), answer('Noted: ACME is the preferred supplier.')),
        // fresh
        h.expectRequest('fresh turn', turnOf(TASKS.fresh), () => ({
          toolCalls: [delegate('call-analyst', { name: 'analyst', task: MEMBER_TASKS.analyst, mode: 'fresh', materialIds: state.materialId === undefined ? [] : [state.materialId], expectedOutput: FILES.summary.path })],
          usage,
        })),
        h.expectRequest('analyst result', mentions(TASKS.fresh), { toolCalls: [{ name: 'write_file', arguments: { path: FILES.report.path, content: FILES.report.content } }], usage }),
        h.expectRequest('report written', mentions(TASKS.fresh), { toolCalls: [{ name: 'present', arguments: { paths: [FILES.report.path, FILES.summary.path], summary: 'Final report with the analyst summary.' } }], usage }),
        h.expectRequest('final presented', mentions(TASKS.fresh), answer('Final report presented.')),
        // fork
        h.expectRequest('fork turn', turnOf(TASKS.fork), { toolCalls: [delegate('call-forker', { name: 'forker', task: MEMBER_TASKS.forker, mode: 'fork' })], usage }),
        h.expectRequest('forker result', mentions(TASKS.fork), answer('The helper says ACME.')),
        // sameName
        h.expectRequest('same-name turn', turnOf(TASKS.sameName), {
          toolCalls: [
            delegate('call-writer-a', { name: 'writer-a', task: MEMBER_TASKS.writerA }),
            delegate('call-writer-b', { name: 'writer-b', task: MEMBER_TASKS.writerB }),
          ],
          usage,
        }),
        h.expectRequest('writers results', mentions(TASKS.sameName), answer('Both writers presented shared/notes.md.')),
      ],
      routes: {
        analyst: [
          h.expectRequest('analyst first request', member('analyst'), { toolCalls: [{ name: 'write_file', arguments: { path: FILES.summary.path, content: FILES.summary.content } }], usage }),
          h.expectRequest('analyst write result', member('analyst'), { toolCalls: [{ name: 'present', arguments: { paths: [FILES.summary.path], summary: 'Stock summary.' } }], usage }),
          h.expectRequest('analyst present result', member('analyst'), answer('Summary written to analysis/summary.md and presented.')),
        ],
        forker: [h.expectRequest('forker first request', member('forker'), answer('ACME.'))],
        'writer-a': [
          h.expectRequest('writer-a first request', member('writer-a'), { toolCalls: [{ name: 'write_file', arguments: { path: FILES.shared.path, content: FILES.shared.a } }], usage }),
          h.expectRequest('writer-a write result', member('writer-a'), { toolCalls: [{ name: 'present', arguments: { paths: [FILES.shared.path], summary: 'Notes from A.' } }], usage }),
          h.expectRequest('writer-a present result', member('writer-a'), answer('Notes A presented.')),
        ],
        'writer-b': [
          h.expectRequest('writer-b first request', member('writer-b'), { toolCalls: [{ name: 'str_replace', arguments: { path: FILES.shared.path, old_str: FILES.shared.a, new_str: FILES.shared.b } }], usage }),
          h.expectRequest('writer-b edit result', member('writer-b'), { toolCalls: [{ name: 'present', arguments: { paths: [FILES.shared.path], summary: 'Notes from B.' } }], usage }),
          h.expectRequest('writer-b present result', member('writer-b'), answer('Notes B presented.')),
        ],
      },
    },
    forkKill: {
      lead: [h.expectRequest('fork-kill turn', turnOf(TASKS.forkKill), { toolCalls: [delegate('call-forker-two', { name: 'forker-two', task: MEMBER_TASKS.forkerTwo, mode: 'fork' })], usage })],
      routes: {
        'forker-two': [h.expectRequest('forker-two first request', member('forker-two'), { content: [STALL_TEXT, ' and more'], fault: { kind: 'timeout', afterChunks: 3 }, usage })],
      },
    },
    resume: {
      lead: [h.expectRequest('resume turn', turnOf(TASKS.resume), answer('We are past the crash; the supplier is ACME.'))],
      routes: {},
    },
    readonly: {
      lead: [
        h.expectRequest('read-only turn', turnOf(TASKS.readonly), { toolCalls: [delegate('call-wide', { name: 'wide-one', task: MEMBER_TASKS.wide, preset: 'wide' })], usage }),
        h.expectRequest('wide refused', mentions(TASKS.readonly), { toolCalls: [delegate('call-quiet', { name: 'quiet', task: MEMBER_TASKS.quiet, preset: 'noshell' })], usage }),
        h.expectRequest('quiet result', mentions(TASKS.readonly), () => ({ toolCalls: [{ id: 'call-web-shipped', name: 'web_fetch', arguments: { url: state.pageUrl } }], usage })),
        h.expectRequest('shipped web_fetch result', mentions(TASKS.readonly), answer('Done.')),
      ],
      routes: {
        quiet: [h.expectRequest('quiet first request', member('quiet'), answer('I have read-only tools and no shell.'))],
      },
    },
    tools: {
      lead: [
        // ptc
        h.expectRequest('ptc turn', turnOf(TASKS.ptc), {
          toolCalls: [{ id: 'call-ptc-files', name: 'run_code', arguments: { code: `const text = await readFile(${JSON.stringify(TOOL_FILES.input.path)}); await writeFile(${JSON.stringify(TOOL_FILES.output)}, text.toUpperCase()); return { read: text, envKeys: Object.keys(process.env) }` } }],
          usage,
        }),
        h.expectRequest('ptc files result', mentions(TASKS.ptc), () => ({
          toolCalls: [{ id: 'call-ptc-outside', name: 'run_code', arguments: { code: `return await readFile(${JSON.stringify(state.outsidePath ?? '../outside')})` } }],
          usage,
        })),
        h.expectRequest('ptc outside result', mentions(TASKS.ptc), {
          toolCalls: [{ id: 'call-ptc-timeout', name: 'run_code', arguments: { code: "console.log('PTC-PID=' + process.pid); for (;;) {}", timeoutMs: 1000 } }],
          usage,
        }),
        h.expectRequest('ptc timeout result', mentions(TASKS.ptc), answer('run_code checks done.')),
        // sheet
        h.expectRequest('sheet turn', turnOf(TASKS.sheet), { toolCalls: [{ id: 'call-sheet-skill', name: 'load_skill', arguments: { name: 'spreadsheets' } }], usage }),
        h.expectRequest('sheet skill loaded', mentions(TASKS.sheet), { toolCalls: [{ id: 'call-sheet-ok', name: 'write_spreadsheet', arguments: { path: TOOL_FILES.sheet, sheets: [{ name: 'Plan', rows: SHEET.rows }] } }], usage }),
        h.expectRequest('sheet written', mentions(TASKS.sheet), { toolCalls: [{ id: 'call-sheet-external', name: 'write_spreadsheet', arguments: { path: TOOL_FILES.rejected[0], sheets: [{ name: 'S', rows: [[1, '=[Book2.xlsx]Sheet1!A1']] }] } }], usage }),
        h.expectRequest('external refused', mentions(TASKS.sheet), { toolCalls: [{ id: 'call-sheet-unknown', name: 'write_spreadsheet', arguments: { path: TOOL_FILES.rejected[1], sheets: [{ name: 'S', rows: [[1, '=NOSUCHFN(A1)']] }] } }], usage }),
        h.expectRequest('unknown refused', mentions(TASKS.sheet), { toolCalls: [{ id: 'call-sheet-divzero', name: 'write_spreadsheet', arguments: { path: TOOL_FILES.rejected[2], sheets: [{ name: 'S', rows: [[0, '=1/A1']] }] } }], usage }),
        h.expectRequest('divzero refused', mentions(TASKS.sheet), { toolCalls: [{ id: 'call-sheet-limit', name: 'write_spreadsheet', arguments: { path: TOOL_FILES.rejected[3], sheets: Array.from({ length: 33 }, (_, i) => ({ name: `S${i + 1}`, rows: [[i]] })) } }], usage }),
        h.expectRequest('limit refused', mentions(TASKS.sheet), answer('Spreadsheet checks done.')),
        // web
        h.expectRequest('web turn', turnOf(TASKS.web), () => ({ toolCalls: [{ id: 'call-web-page', name: 'web_fetch', arguments: { url: state.pageUrl } }], usage })),
        h.expectRequest('page fetched', mentions(TASKS.web), () => ({ toolCalls: [{ id: 'call-web-loopback', name: 'web_fetch', arguments: { url: state.loopbackUrl } }], usage })),
        h.expectRequest('loopback refused', mentions(TASKS.web), { toolCalls: [{ id: 'call-web-private', name: 'web_fetch', arguments: { url: 'http://10.0.0.1/stock.html' } }], usage }),
        h.expectRequest('private refused', mentions(TASKS.web), () => ({ toolCalls: [{ id: 'call-web-redirect', name: 'web_fetch', arguments: { url: state.redirectUrl } }], usage })),
        h.expectRequest('redirect refused', mentions(TASKS.web), answer('Web checks done.')),
      ],
      routes: {},
    },
    workflow: {
      lead: [
        h.expectRequest('workflow script turn', turnOf(TASKS.wfScript), {
          toolCalls: [{ id: 'call-wf-script', name: 'workflow', arguments: {
            title: 'Count and summarise',
            script: [
              "phase('count')",
              `const parts = await parallel(${JSON.stringify(WF_PARTS)}.map(name => () => agent('Count ' + name + ' of the stock.', { name })))`,
              "phase('summarise')",
              "const [summary] = await pipeline([parts.map(p => p.text).join('\\n')], text => agent('Summarise these counts into final/summary.md and present it:\\n' + text, { name: 'summariser' }))",
              'return { parts: parts.length, summary: summary.status }',
            ].join('\n'),
          } }],
          usage,
        }),
        h.expectRequest('workflow script result', mentions(TASKS.wfScript), answer('The workflow finished.')),
        h.expectRequest('graph turn', turnOf(TASKS.wfGraph), { toolCalls: [{ id: 'call-wf-graph', name: 'workflow', arguments: { title: 'Three steps', graph: WF_GRAPH } }], usage }),
        h.expectRequest('graph result', mentions(TASKS.wfGraph), { toolCalls: [{ id: 'call-wf-cycle', name: 'workflow', arguments: { title: 'Loop', graph: WF_CYCLE } }], usage }),
        h.expectRequest('cycle refused', mentions(TASKS.wfGraph), answer('The loop was refused.')),
      ],
      routes: {
        ...Object.fromEntries(WF_PARTS.map(name => [name, [h.expectRequest(`${name} request`, member(name), { content: [`${name}: `, 'counted ', '3 SKUs.'], chunkDelayMs: 120, usage })]])),
        summariser: [
          h.expectRequest('summariser first request', member('summariser'), { toolCalls: [{ name: 'write_file', arguments: { path: 'final/summary.md', content: '# Summary\n\n15 SKUs counted.\n' } }], usage }),
          h.expectRequest('summariser write result', member('summariser'), { toolCalls: [{ name: 'present', arguments: { paths: ['final/summary.md'], summary: 'Workflow summary.' } }], usage }),
          h.expectRequest('summariser present result', member('summariser'), answer('Summary presented.')),
        ],
        gather: [h.expectRequest('gather request', member('gather'), answer('P01, P02, P03.'))],
        check: [h.expectRequest('check request', member('check'), answer('No duplicates.'))],
        report: [h.expectRequest('report request', member('report'), answer('Three SKUs, no duplicates.'))],
      },
    },
    wfKill: {
      lead: [h.expectRequest('workflow kill turn', turnOf(TASKS.wfKill), {
        toolCalls: [{ id: 'call-wf-kill', name: 'workflow', arguments: { title: 'Early then late', script: "const early = await agent('Count early.', { name: 'early' })\nconst late = await agent('Count late.', { name: 'late' })\nreturn [early.status, late.status]" } }],
        usage,
      })],
      routes: {
        early: [h.expectRequest('early request', member('early'), answer('Early: 4 SKUs.'))],
        late: [h.expectRequest('late request', member('late'), { content: [WF_STALL_TEXT, ' and more'], fault: { kind: 'timeout', afterChunks: 3 }, usage })],
      },
    },
    wfResume: {
      lead: [h.expectRequest('workflow resume turn', turnOf(TASKS.wfResume), answer('The workflow was interrupted; early had finished.'))],
      routes: {},
    },
    teamWork: {
      lead: [
        h.expectRequest('team turn', turnOf(TASKS.teamWork), calls(
          call('team_task_create', { title: 'Write a' }, 'c1'),
          call('team_task_create', { title: 'Write b' }, 'c2'),
          call('team_task_create', { title: 'Merge a and b', dependsOn: ['t1', 't2'] }, 'c3'),
        )),
        h.expectRequest('tasks created', mentions(TASKS.teamWork), calls(
          call('spawn_teammate', { name: 'alice', task: 'Do task t1: write alice/a.md.' }, 's1'),
          call('spawn_teammate', { name: 'bob', task: 'Do task t2: write bob/b.md.' }, 's2'),
        )),
        h.expectRequest('teammates spawned', mentions(TASKS.teamWork), calls(call('wait_teammates', { until: 'idle' }, 'w1'))),
        h.expectRequest('teammates waited', mentions(TASKS.teamWork), calls(call('team_task_update', { id: 't3', status: 'in_progress' }, 'u3'), call('team_task_list', {}, 'l1'))),
        h.expectRequest('board listed', mentions(TASKS.teamWork), answer('Both parts are written.')),
      ],
      routes: {
        alice: [
          slow(calls(call('team_task_update', { id: 't1', status: 'in_progress' }, 'a1'))),
          slow(calls(call('write_file', { path: 'alice/a.md', content: 'part a\n' }, 'a2'))),
          slow(calls(call('present', { paths: ['alice/a.md'], summary: 'Part a.' }, 'a3'))),
          slow(calls(call('send_message', { to: 'bob', text: TEAM_TEXT.toBob }, 'a4'), call('send_message', { to: 'lead', text: TEAM_TEXT.toLead }, 'a5'))),
          slow(calls(call('team_task_update', { id: 't1', status: 'completed', result: 'alice/a.md written' }, 'a6'))),
          answer('alice done'),
        ],
        bob: [
          slow(calls(call('team_task_update', { id: 't3', status: 'in_progress' }, 'b0'))),
          slow(calls(call('team_task_update', { id: 't2', status: 'in_progress' }, 'b1'))),
          slow(calls(call('write_file', { path: 'bob/b.md', content: 'part b\n' }, 'b2'))),
          slow(calls(call('present', { paths: ['bob/b.md'], summary: 'Part b.' }, 'b3'))),
          slow(calls(call('team_task_update', { id: 't2', status: 'completed', result: 'bob/b.md written' }, 'b4'))),
          answer('bob done'),
          answer('bob read the message'),
        ],
      },
    },
    teamKill: {
      lead: [
        h.expectRequest('team kill turn', turnOf(TASKS.teamKill), calls(
          call('team_task_create', { title: 'Collect' }, 'k1'),
          call('team_task_create', { title: 'Report', dependsOn: ['t1'] }, 'k2'),
          call('spawn_teammate', { name: 'bob', task: 'Say you are ready.' }, 'k3'),
        )),
        h.expectRequest('bob spawned', mentions(TASKS.teamKill), calls(call('wait_teammates', {}, 'k4'))),
        h.expectRequest('bob waited', mentions(TASKS.teamKill), calls(call('spawn_teammate', { name: 'alice', task: 'Collect, then tell bob and the lead.' }, 'k5'))),
        h.expectRequest('alice spawned', mentions(TASKS.teamKill), { content: [TEAM_STALL_TEXT, ' more'], fault: { kind: 'timeout', afterChunks: 1 }, usage }),
      ],
      routes: {
        bob: [answer('bob ready')],
        alice: [
          calls(call('team_task_update', { id: 't1', status: 'in_progress' }, 'ka1')),
          calls(call('send_message', { to: 'bob', text: TEAM_TEXT.killToBob }, 'ka2'), call('send_message', { to: 'lead', text: TEAM_TEXT.killToLead }, 'ka3')),
          { content: ['collecting', ' more'], fault: { kind: 'timeout', afterChunks: 1 }, usage },
        ],
      },
    },
    teamResume: {
      lead: [
        h.expectRequest('team resume turn', turnOf(TASKS.teamResume), calls(call('team_task_list', {}, 'r1'))),
        h.expectRequest('board after resume', mentions(TASKS.teamResume), calls(call('wait_teammates', {}, 'r2'))),
        h.expectRequest('teammates after resume', mentions(TASKS.teamResume), answer('recovered')),
      ],
      routes: { alice: [answer('alice continued')], bob: [answer('bob read it')] },
    },
    cancelDelegate: {
      lead: [h.expectRequest('cancel delegate turn', turnOf(TASKS.cancelDelegate), calls(call('delegate', { name: 'sleeper', task: 'Run the slow check.' }, 'x1')))],
      routes: { sleeper: [{ content: 'Starting.', toolCalls: [shellCall(SLOW_COMMAND)], usage }] },
    },
    cancelTeam: {
      lead: [
        h.expectRequest('cancel team turn', turnOf(TASKS.cancelTeam), calls(
          call('spawn_teammate', { name: 'mate-a', task: 'Run the slow check.' }, 'x2'),
          call('spawn_teammate', { name: 'mate-b', task: 'Run the slow check.' }, 'x3'),
        )),
        h.expectRequest('mates spawned', mentions(TASKS.cancelTeam), calls(call('wait_teammates', {}, 'x4'))),
      ],
      routes: {
        'mate-a': [{ content: 'Starting.', toolCalls: [shellCall(SLOW_COMMAND)], usage }],
        'mate-b': [{ content: 'Starting.', toolCalls: [shellCall(SLOW_COMMAND)], usage }],
      },
    },
    cancelWorkflow: {
      lead: [h.expectRequest('cancel workflow turn', turnOf(TASKS.cancelWorkflow), calls(call('workflow', { title: 'Slow checks', script: "await parallel([() => agent('Run the slow check.', { name: 'flow-a' }), () => agent('Run the slow check.', { name: 'flow-b' })])" }, 'x5')))],
      routes: {
        'flow-a': [{ content: 'Starting.', toolCalls: [shellCall(SLOW_COMMAND)], usage }],
        'flow-b': [{ content: 'Starting.', toolCalls: [shellCall(SLOW_COMMAND)], usage }],
      },
    },
    budget: {
      // One root entry only: the request after the member's must never be sent.
      lead: [h.expectRequest('budget turn', turnOf(TASKS.budget), calls(call('delegate', { name: 'spender', task: MEMBER_TASKS.spender }, 'call-spender')))],
      routes: { spender: [h.expectRequest('spender request', member('spender'), answer('Stock: 6 SKUs.'))] },
    },
    memberApproval: {
      lead: [
        h.expectRequest('member approval turn', turnOf(TASKS.memberApproval), calls(call('delegate', { name: 'keeper', task: MEMBER_TASKS.keeper }, 'call-keeper'))),
        h.expectRequest('keeper result', mentions(TASKS.memberApproval), answer('The member was not allowed to change .env.')),
      ],
      routes: {
        keeper: [
          h.expectRequest('keeper edit', member('keeper'), calls(call('str_replace', { path: MEMBER_ENV.path, old_str: MEMBER_ENV.from, new_str: MEMBER_ENV.to }, 'call-keeper-env'))),
          h.expectRequest('keeper denied', member('keeper'), answer('The edit was not approved.')),
        ],
      },
    },
    skills: {
      lead: [
        h.expectRequest('skills turn', turnOf(TASKS.skills), calls(
          call('load_skill', { name: SKILLS.user.name }, 'call-skill-user'),
          call('load_skill', { name: SKILLS.shared.name }, 'call-skill-shared'),
        )),
        h.expectRequest('skills loaded', mentions(TASKS.skills), answer('Both skills loaded.')),
      ],
      routes: {},
    },
  }
}
