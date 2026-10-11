import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ApprovalDecision, MaterialMetadata } from '@nexgent/kernel'
import {
  SDK_API_VERSION,
  SDK_METHOD_NAMES,
  type NexgentSdk,
  type SdkEvent,
  type SdkInput,
  type SdkMethodName,
  type SdkResult,
} from '../src/index.js'

describe('@nexgent/sdk interface', () => {
  it('lists every method exactly once, and nothing else', () => {
    expect(new Set(SDK_METHOD_NAMES).size).toBe(SDK_METHOD_NAMES.length)
    expectTypeOf<(typeof SDK_METHOD_NAMES)[number]>().toEqualTypeOf<SdkMethodName>()
    expect(SDK_API_VERSION).toBe(2)
  })

  it('types inputs and results by method name', () => {
    expectTypeOf<SdkInput<'materials.add'>>().toEqualTypeOf<{ readonly projectId: string; readonly sourcePath: string; readonly sessionId?: string }>()
    expectTypeOf<SdkResult<'materials.add'>>().toEqualTypeOf<MaterialMetadata>()
    expectTypeOf<SdkInput<'approvals.respond'>['decision']>().toEqualTypeOf<Omit<ApprovalDecision, 'decidedBy'>>()
    expectTypeOf<NexgentSdk['call']>().parameter(0).toEqualTypeOf<SdkMethodName>()
  })

  it('never exposes the API key value through settings', () => {
    expectTypeOf<SdkResult<'settings.get'>['apiKey']>().toEqualTypeOf<import('@nexgent/kernel').CredentialInfo>()
    expectTypeOf<SdkResult<'settings.setApiKey'>>().toEqualTypeOf<import('@nexgent/kernel').CredentialInfo>()
  })

  it('ends a turn with exactly one turn.end event type', () => {
    expectTypeOf<Extract<SdkEvent, { type: 'turn.end' }>['reason']>().toEqualTypeOf<import('@nexgent/kernel').TurnEndReason>()
  })
})
