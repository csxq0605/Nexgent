---
name: office-documents
description: Read Word (.docx), Excel (.xlsx) and PDF (.pdf) files as text and tables with the read_document tool.
when_to_use: a material or project file is a .docx, .xlsx or .pdf document whose content the task needs.
tools: [read_document]
---

# Reading Office documents

Use `read_document` for `.docx`, `.xlsx` and `.pdf` files. `read_file` cannot read them: they are binary packages. Attached materials are read-only copies; pass the path given in the materials list. Never try to edit or overwrite a material; write results to new files in the project.

## Excel (.xlsx)

- Without `sheet`, every sheet is returned. Each starts with `## Sheet: <name> (range A1:D120, 120 rows × 4 columns)`, followed by the rows as CSV (fields with commas, quotes or line breaks are quoted).
- Values are the cached cell values. Formulas are not recalculated, so a workbook saved without recalculation can show stale numbers. Dates and times are shown as ISO-8601 text; other numbers are shown as stored, without number formatting (no thousands separators, currency or percent signs).
- Only the first 500 rows of each sheet are returned by default; a note says how many there are. Pass `maxRows` for more, and `sheet` to read one sheet. For large sheets, read the header and a sample first, then write a script (Python with only the standard library, or Node) that processes the data once you understand its layout. Ask before installing packages.
- Merged cells show their value in the top-left cell only. Hidden sheets, rows and columns are included.

## Word (.docx)

- Paragraphs come one per line. Headings are prefixed with `#`, list items with `- `, and table rows are rendered as `| a | b |`.
- Only the main body is read: headers, footers, footnotes, comments and text boxes outside the body are not included. Tracked deletions are left out; insertions are included.
- Images and embedded objects are not described.

## PDF (.pdf)

- Text comes page by page under `## Page <n> of <total>`. Pass `pages` (for example `"1-3"` or `"2,5-6"`) to read part of a long document.
- Pages that are scanned images have no text layer and come out empty; `read_document` cannot read them (there is no OCR). Say so instead of guessing their content.
- Column layouts and tables can come out in reading order that mixes columns; check numbers against the surrounding text before relying on them.
- Password-protected PDFs cannot be read.

## Limits

- Files up to 50 MiB; output is cut at 100 000 characters with a note on how to narrow the request.
- Macros, scripts and embedded content are never executed.
- `.doc`, `.xls`, `.xlsm`, `.pptx` and other formats are not supported; say what the file is and what the user can do (for example, save it as .xlsx).
