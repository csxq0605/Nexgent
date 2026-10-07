import { describe, expect, it } from 'vitest'
import { createApp, Greeter, ValidationError } from '../src/index.js'

describe('createApp', () => {
  it('boots a Cordis context, applies a plugin and exposes its service', async () => {
    const app = createApp()
    expect(app.ctx.get('greeter')).toBeUndefined()

    const fiber = await app.ctx.plugin(Greeter, { greeting: 'hi' })
    expect(app.ctx.greeter).toBeInstanceOf(Greeter)
    expect(app.ctx.greeter.greet('nexgent')).toBe('hi, nexgent')
    expect(app.ctx.greeter.count).toBe(1)

    await fiber.dispose()
    expect(app.ctx.get('greeter')).toBeUndefined()
    await app.dispose()
  })

  it('fills config defaults from the schemastery schema', async () => {
    const app = createApp()
    await app.ctx.plugin(Greeter)
    expect(app.ctx.greeter.greet('world')).toBe('hello, world')
    await app.dispose()
    expect(app.ctx.get('greeter')).toBeUndefined()
  })

  it('rejects config that fails schema validation', async () => {
    const app = createApp()
    await expect(app.ctx.plugin(Greeter, { greeting: 42 as unknown as string })).rejects.toBeInstanceOf(
      ValidationError,
    )
    await app.dispose()
  })

  it('runs dependent plugins only once the service they inject is available', async () => {
    const app = createApp()
    const seen: string[] = []
    const consumer = Object.assign(
      (ctx: typeof app.ctx) => {
        seen.push(ctx.greeter.greet('consumer'))
      },
      { inject: ['greeter'] },
    )
    app.ctx.plugin(consumer)
    expect(seen).toEqual([])

    await app.ctx.plugin(Greeter, { greeting: 'hey' })
    expect(seen).toEqual(['hey, consumer'])
    await app.dispose()
  })
})
