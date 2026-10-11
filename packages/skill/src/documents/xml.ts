/**
 * A minimal XML event scanner for the OOXML parts `read_document` reads
 * (`word/document.xml`, `xl/sharedStrings.xml`, sheets). It is not a
 * validating parser: it reports start tags (with attributes), end tags and
 * text, decodes the five predefined entities and numeric references, keeps
 * CDATA as text, and skips comments, processing instructions and the DTD.
 * Namespace prefixes are kept as written (`w:t`); callers compare local names.
 */

/** One scanner event. */
export type XmlEvent =
  | { readonly kind: 'open'; readonly name: string; readonly attrs: Readonly<Record<string, string>>; readonly selfClosing: boolean }
  | { readonly kind: 'close'; readonly name: string }
  | { readonly kind: 'text'; readonly text: string }

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Decode entity and character references. Pure. */
export function decodeXmlText(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref.startsWith('#x')) return safeCodePoint(Number.parseInt(ref.slice(2), 16)) ?? whole
    if (ref.startsWith('#')) return safeCodePoint(Number.parseInt(ref.slice(1), 10)) ?? whole
    return ENTITIES[ref] ?? whole
  })
}

function safeCodePoint(code: number): string | undefined {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined
}

/** Local part of a qualified name (`w:t` → `t`). Pure. */
export function localName(name: string): string {
  const colon = name.indexOf(':')
  return colon === -1 ? name : name.slice(colon + 1)
}

const ATTR = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g

/**
 * Scan a document into events.
 * @throws `Error` on an unterminated tag, comment or CDATA section (the caller maps it to a tool error).
 */
export function* scanXml(xml: string): Generator<XmlEvent> {
  let pos = 0
  const length = xml.length
  while (pos < length) {
    const lt = xml.indexOf('<', pos)
    if (lt === -1) {
      const tail = xml.slice(pos)
      if (tail.trim() !== '') yield { kind: 'text', text: decodeXmlText(tail) }
      return
    }
    if (lt > pos) yield { kind: 'text', text: decodeXmlText(xml.slice(pos, lt)) }
    if (xml.startsWith('<!--', lt)) {
      pos = endOf(xml, '-->', lt + 4, 'comment')
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      if (end === -1) throw new Error('unterminated CDATA section')
      yield { kind: 'text', text: xml.slice(lt + 9, end) }
      pos = end + 3
      continue
    }
    if (xml.startsWith('<?', lt)) {
      pos = endOf(xml, '?>', lt + 2, 'processing instruction')
      continue
    }
    if (xml.startsWith('<!', lt)) {
      pos = skipDeclaration(xml, lt)
      continue
    }
    const gt = tagEnd(xml, lt + 1)
    const body = xml.slice(lt + 1, gt)
    pos = gt + 1
    if (body.startsWith('/')) {
      yield { kind: 'close', name: body.slice(1).trim() }
      continue
    }
    const selfClosing = body.endsWith('/')
    const inner = selfClosing ? body.slice(0, -1) : body
    const space = inner.search(/\s/)
    const name = space === -1 ? inner : inner.slice(0, space)
    const attrs: Record<string, string> = {}
    if (space !== -1) {
      for (const match of inner.slice(space).matchAll(ATTR)) attrs[match[1]!] = decodeXmlText(match[3] ?? match[4] ?? '')
    }
    yield { kind: 'open', name, attrs, selfClosing }
  }
}

function endOf(xml: string, marker: string, from: number, what: string): number {
  const end = xml.indexOf(marker, from)
  if (end === -1) throw new Error(`unterminated ${what}`)
  return end + marker.length
}

/** Index of the `>` closing a tag, skipping `>` inside quoted attribute values. */
function tagEnd(xml: string, from: number): number {
  let quote: string | undefined
  for (let i = from; i < xml.length; i++) {
    const ch = xml[i]
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      return i
    }
  }
  throw new Error('unterminated tag')
}

/** Skip `<!DOCTYPE ...>` including an internal subset in brackets. */
function skipDeclaration(xml: string, from: number): number {
  let depth = 0
  for (let i = from + 2; i < xml.length; i++) {
    const ch = xml[i]
    if (ch === '[') depth++
    else if (ch === ']') depth--
    else if (ch === '>' && depth <= 0) return i + 1
  }
  throw new Error('unterminated declaration')
}
