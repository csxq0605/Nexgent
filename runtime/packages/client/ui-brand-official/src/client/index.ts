/** Official DeepSeek Harness occupants for the generic browser-brand slots. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { NexgentBrandMark, NexgentBrandName, OfficialBrandMark, OfficialBrandName } from './Brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill the sidebar brand slots as one declaration-aware registration set. The
 * conversation hero stays on its declaring package's animated fish fallback,
 * so the official build registers nothing there.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const nexgent = process.env.DSH_CLIENT_BUILD_PROFILE === 'nexgent'
  if (!nexgent && process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') return
  const mark = nexgent ? NexgentBrandMark : OfficialBrandMark
  const name = nexgent ? NexgentBrandName : OfficialBrandName
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, mark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, name)
    }))
}
