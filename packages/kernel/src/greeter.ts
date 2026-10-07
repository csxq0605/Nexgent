/**
 * Example Cordis plugin: a `Greeter` service with a schemastery config.
 *
 * It exists only to exercise the three mechanisms Nexgent builds on:
 * config validation (`static Config`), service registration (`Service`
 * subclass registered as `ctx.greeter`) and fiber-scoped disposal.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: Greeter
  }
}

export interface GreeterConfig {
  /** Word placed before the name, e.g. `"hello"`. */
  greeting: string
  /** Separator between greeting and name. */
  separator: string
}

export class Greeter extends Service {
  static readonly Config = Schema.object({
    greeting: Schema.string().default('hello').description('Word placed before the name.'),
    separator: Schema.string().default(', ').description('Separator between greeting and name.'),
  })

  /** Number of greetings produced by this instance. */
  count = 0

  constructor(ctx: Context, private readonly config: GreeterConfig) {
    super(ctx, 'greeter')
  }

  greet(name: string): string {
    this.count += 1
    return `${this.config.greeting}${this.config.separator}${name}`
  }
}
