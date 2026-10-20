/**
 * Decision 2: a component may be proposed only when this session used it
 * successfully at least once after trying it (`agent-hooks.md` §步骤 4 工具).
 * Pure over the session's records, so the rule is testable without a loop.
 *
 * What counts as a use, per kind, after the component's latest
 * `capability.try`:
 * - `function-module`, `plugin`: a call of one of the tools that try added;
 * - `skill`: `load_skill` with the component's name;
 * - `preset`: `delegate` with `preset` equal to the name,
 *   or `workflow` whose graph has a node with that preset;
 * - `team-template`: an `organize` call;
 * - `architecture`: a `workflow` call with a `graph`;
 * - `context-policy` (nothing calls it): a turn after the try's turn that
 *   completed; the proof names the `capability_try` call.
 * The call's `tool.result` must have `isError: false`.
 */
import type { CapabilityComponentRef, CapabilityTryRecord, ComponentUseProof, SessionRecord, ToolCall } from '@nexgent/kernel'

/** The latest `capability.try` of a component, or `undefined`. */
export function latestTry(records: readonly SessionRecord[], component: CapabilityComponentRef): CapabilityTryRecord | undefined {
  let found: CapabilityTryRecord | undefined
  for (const record of records) {
    if (record.type === 'capability.try' && record.component.kind === component.kind && record.component.name === component.name) found = record
  }
  return found
}

function parse(call: ToolCall): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(call.arguments)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function graphUsesPreset(input: Record<string, unknown>, name: string): boolean {
  const graph = input.graph as { nodes?: unknown } | undefined
  return Array.isArray(graph?.nodes) && graph.nodes.some(node => (node as { preset?: unknown } | null)?.preset === name)
}

function uses(component: CapabilityComponentRef, call: ToolCall, tools: readonly string[]): boolean {
  switch (component.kind) {
    case 'function-module':
    case 'plugin':
      return tools.includes(call.name)
    case 'skill':
      return call.name === 'load_skill' && parse(call).name === component.name
    case 'preset': {
      if (call.name === 'delegate') return parse(call).preset === component.name
      return call.name === 'workflow' && graphUsesPreset(parse(call), component.name)
    }
    case 'team-template':
      return call.name === 'organize'
    case 'architecture':
      return call.name === 'workflow' && parse(call).graph !== undefined
    default:
      return false
  }
}

/**
 * The first successful use of a component after its latest try.
 * @returns the proof, or a sentence saying what is missing.
 */
export function findUseProof(records: readonly SessionRecord[], component: CapabilityComponentRef): ComponentUseProof | string {
  const tried = latestTry(records, component)
  if (tried === undefined) return 'it was never tried in this session (call capability_try first)'
  const start = records.indexOf(tried)
  if (component.kind === 'context-policy') {
    const later = records.slice(start + 1).find(record => record.type === 'turn.end' && record.turn > tried.turn && record.reason.kind === 'completed')
    return later === undefined
      ? 'a context policy needs a completed turn after the turn that tried it'
      : { kind: component.kind, name: component.name, turn: tried.turn, toolCallId: tried.toolCallId }
  }
  const tools = tried.tools ?? []
  const calls = new Map<string, { readonly call: ToolCall; readonly turn: number }>()
  for (const record of records.slice(start + 1)) {
    if (record.type === 'assistant.message') {
      for (const call of record.toolCalls ?? []) if (uses(component, call, tools)) calls.set(call.id, { call, turn: record.turn })
    } else if (record.type === 'tool.result' && !record.isError) {
      const hit = calls.get(record.toolCallId)
      if (hit !== undefined) return { kind: component.kind, name: component.name, turn: hit.turn, toolCallId: record.toolCallId }
    }
  }
  return 'it has no successful use since it was last tried'
}
