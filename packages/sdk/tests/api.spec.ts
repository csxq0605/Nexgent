import { describe, expect, expectTypeOf, it } from 'vitest'
import { SDK_METHOD_NAMES, type SdkMethodName, type SdkResult } from '../src/index.js'

describe('@nexgent/sdk interface', () => {
  it('lists every method exactly once, and nothing else', () => {
    expect(new Set(SDK_METHOD_NAMES).size).toBe(SDK_METHOD_NAMES.length)
    expectTypeOf<(typeof SDK_METHOD_NAMES)[number]>().toEqualTypeOf<SdkMethodName>()
  })

  it('never exposes the API key value through settings', () => {
    expectTypeOf<SdkResult<'settings.get'>['apiKey']>().toEqualTypeOf<import('@nexgent/kernel').CredentialInfo>()
    expectTypeOf<SdkResult<'settings.setApiKey'>>().toEqualTypeOf<import('@nexgent/kernel').CredentialInfo>()
  })

  it('gives the plugin approval dialog each plugin\'s permissions text', () => {
    expectTypeOf<SdkResult<'capabilities.show'>['plugins']>().toEqualTypeOf<readonly import('@nexgent/kernel').PluginApprovalInfo[] | undefined>()
  })

  it('step 5: improvement jobs link to their diagnosis and candidate; settings carry autoImprove', () => {
    expect(SDK_METHOD_NAMES).toEqual(expect.arrayContaining(['improvements.list', 'improvements.show', 'improvements.run', 'improvements.cancel']))
    expectTypeOf<SdkResult<'improvements.show'>['diagnosis']>().toEqualTypeOf<import('@nexgent/kernel').Diagnosis | undefined>()
    expectTypeOf<SdkResult<'improvements.show'>['candidate']>().toEqualTypeOf<import('../src/index.js').CandidateDetail | undefined>()
    expectTypeOf<SdkResult<'settings.get'>['autoImprove']>().toBeBoolean()
  })
})
