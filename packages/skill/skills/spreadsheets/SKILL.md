---
name: spreadsheets
description: Read an .xlsx workbook with recalculated formulas, and write a new .xlsx with live formulas.
when_to_use: the task needs formula values you can trust in an existing .xlsx, or its result is a workbook that should keep working formulas.
tools: [read_spreadsheet, write_spreadsheet]
---

# Spreadsheets

Loading this skill makes `read_spreadsheet` and `write_spreadsheet` available from your next step. Their descriptions list the arguments and limits.

- `read_spreadsheet` returns cell values with formulas recalculated, plus the formula behind each cell. Use it instead of `read_document` when cached values may be stale or the formulas matter.
- `write_spreadsheet` creates a new workbook from rows of cells. A text cell starting with `=` is stored as a live formula together with its calculated value. A formula it cannot evaluate is refused and nothing is written.
- It does not edit an existing workbook in place: read it, then write a new file.
