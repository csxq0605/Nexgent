import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_ORIGIN,
  contentSecurityPolicy,
  contentTypeOf,
  devOrigin,
  navigationVerdict,
  openVerdict,
  originChecker,
  originOf,
  resolveAppFile,
} from '../src/main/origin.js'

const ours = originChecker(undefined)

describe('origins', () => {
  it('derives the app origin', () => {
    expect(originOf('app://nexgent/index.html')).toBe(APP_ORIGIN)
    expect(originOf('not a url')).toBeUndefined()
  })

  it('accepts only localhost http with a port as the dev origin', () => {
    expect(devOrigin('http://localhost:5173/')).toBe('http://localhost:5173')
    expect(devOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173')
    for (const url of ['https://localhost:5173', 'http://example.com:5173', 'http://localhost', 'file:///x', '', undefined]) {
      expect(devOrigin(url)).toBeUndefined()
    }
  })

  it('checks page origins', () => {
    expect(ours('app://nexgent/index.html')).toBe(true)
    expect(ours('app://other/index.html')).toBe(false)
    expect(ours('http://localhost:5173/')).toBe(false)
    expect(originChecker('http://localhost:5173')('http://localhost:5173/x')).toBe(true)
  })
})

describe('navigation', () => {
  const current = 'app://nexgent/index.html'

  it('allows same-origin navigation only', () => {
    expect(navigationVerdict('app://nexgent/other.html', current, ours)).toBe('allow')
    for (const target of ['https://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'app://evil/index.html']) {
      expect(navigationVerdict(target, current, ours)).toBe('deny')
    }
  })

  it('denies even same-origin navigation when the current page is not ours', () => {
    expect(navigationVerdict('https://example.com/b', 'https://example.com/a', ours)).toBe('deny')
  })

  it('sends only http(s) links to the system browser', () => {
    expect(openVerdict('https://example.com/')).toBe('external')
    expect(openVerdict('http://example.com/')).toBe('external')
    for (const target of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'app://nexgent/x', 'smb://host/share', 'nonsense']) {
      expect(openVerdict(target)).toBe('deny')
    }
  })
})

describe('app:// file mapping', () => {
  const root = join(process.cwd(), 'renderer-root')

  it('maps paths inside the renderer directory', () => {
    expect(resolveAppFile(root, 'app://nexgent/')).toBe(join(root, 'index.html'))
    expect(resolveAppFile(root, 'app://nexgent/index.html')).toBe(join(root, 'index.html'))
    expect(resolveAppFile(root, 'app://nexgent/assets/app.js?v=1#x')).toBe(join(root, 'assets', 'app.js'))
  })

  it('refuses traversal, other hosts and odd encodings', () => {
    for (const url of [
      'app://nexgent/..%2fsecret',
      'app://nexgent/a%5c..%5csecret',
      'app://nexgent/C:/Windows/win.ini',
      'app://nexgent/%00',
      'app://nexgent/%E0%A4%A',
      'app://other/index.html',
      'file:///etc/passwd',
      'garbage',
    ]) {
      expect(resolveAppFile(root, url)).toBeUndefined()
    }
  })

  it('keeps dot segments the URL parser collapses inside the root', () => {
    expect(resolveAppFile(root, 'app://nexgent/%2e%2e/secret')).toBe(join(root, 'secret'))
    expect(resolveAppFile(root, 'app://nexgent/assets/%2E%2E/%2E%2E/secret')).toBe(join(root, 'secret'))
  })

  it('serves known content types', () => {
    expect(contentTypeOf('a.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeOf('a.HTML')).toBe('text/html; charset=utf-8')
    expect(contentTypeOf('a.exe')).toBe('application/octet-stream')
  })
})

describe('content security policy', () => {
  it('matches the spec in packaged builds', () => {
    expect(contentSecurityPolicy(undefined)).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    )
  })

  it('relaxes only connect-src for the dev server', () => {
    const csp = contentSecurityPolicy('http://localhost:5173')
    expect(csp).toContain("connect-src 'self' http://localhost:5173 ws://localhost:5173;")
    expect(csp).toContain("script-src 'self';")
  })
})
