/*
 * A deliverable file's text as the user reads it: a CSV file, or a
 * spreadsheet (which `deliverables.readText` returns as `## Sheet:` sections
 * of CSV rows), as tables; anything else as plain text.
 */

/** RFC 4180 rows of `text` (quoted fields may hold commas, quotes and line breaks). Pure. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** One sheet of a spreadsheet's extracted text. */
export interface SheetText {
  readonly heading: string
  readonly rows: string[][]
  /** Lines after the rows (`[showing the first … rows …]`), shown as a note. */
  readonly note?: string
}

/** Split a spreadsheet's extracted text into its sheets. Pure. */
export function parseSheets(text: string): SheetText[] {
  return text.split(/\n(?=## Sheet: )/).filter(part => part.startsWith('## Sheet: ')).map(part => {
    const newline = part.indexOf('\n')
    // `name (range A1:D6, 6 rows × 4 columns)` → the sheet's name.
    const heading = (newline === -1 ? part : part.slice(0, newline)).slice('## Sheet: '.length).replace(/ \(range [^)]*\)$/, '')
    let body = newline === -1 ? '' : part.slice(newline + 1).replace(/\n+$/, '')
    let note: string | undefined
    const last = body.lastIndexOf('\n[showing the first ')
    if (body.startsWith('[showing the first ')) {
      note = body
      body = ''
    } else if (last !== -1) {
      note = body.slice(last + 1)
      body = body.slice(0, last)
    }
    const rows = body === '(empty)' ? [] : parseCsv(body)
    const shown = note === undefined ? undefined : /\[showing the first (\d+) of (\d+) rows/.exec(note)
    const noteText = shown === undefined ? undefined : shown === null ? note!.trim() : `只显示前 ${shown[1]} 行，共 ${shown[2]} 行；完整内容请在文件管理器中打开。`
    return { heading, rows, ...(noteText === undefined ? {} : { note: noteText }) }
  })
}

function Table({ rows }: { readonly rows: string[][] }): JSX.Element {
  const [head, ...rest] = rows
  return (
    <div className="table-scroll">
      <table className="preview-table">
        {head !== undefined && (
          <thead>
            <tr>
              {head.map((cell, index) => (
                <th key={index}>{cell}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rest.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function FilePreview({ path, text }: { readonly path: string; readonly text: string }): JSX.Element {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  if (extension === '.xlsx') {
    const sheets = parseSheets(text)
    if (sheets.length > 0) {
      return (
        <div className="file-content sheets" data-testid="file-content">
          {sheets.map((sheet, index) => (
            <section key={index} className="sheet" data-testid="preview-sheet">
              <h4 className="small">{sheet.heading}</h4>
              {sheet.rows.length === 0 ? <p className="muted small">（空）</p> : <Table rows={sheet.rows} />}
              {sheet.note !== undefined && <p className="muted small">{sheet.note}</p>}
            </section>
          ))}
        </div>
      )
    }
  }
  if (extension === '.csv') {
    const rows = parseCsv(text)
    if (rows.length > 0) {
      return (
        <div className="file-content sheets" data-testid="file-content">
          <Table rows={rows} />
        </div>
      )
    }
  }
  return (
    <pre className="file-content" data-testid="file-content">
      {text}
    </pre>
  )
}
