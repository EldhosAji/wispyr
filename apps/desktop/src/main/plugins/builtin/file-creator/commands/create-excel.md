---
description: Create an Excel file with data, styled headers, and optional charts
allowed-tools: write_file, read_file, generate_skill
argument-hint: describe the Excel file you want
---

## Your task

Create an Excel (.xlsx) file based on the user's request.

Call write_file with the "data" parameter structured as:
```json
{
  "sheets": [
    {
      "name": "Sheet1",
      "headers": ["Column1", "Column2"],
      "rows": [["value1", "value2"]]
    }
  ],
  "charts": [
    {
      "type": "pie",
      "title": "Chart Title",
      "dataSheet": "Sheet1",
      "chartSheet": "Chart",
      "categoryColumn": "A",
      "valueColumn": "B",
      "startRow": 2,
      "endRow": 10
    }
  ]
}
```

Rules:
- "headers" is REQUIRED — always provide column headers
- "rows" contains data only (no headers repeated)
- Generate realistic sample data (at least 10-20 rows)
- Charts are supported: pie, bar, column, line, doughnut
- "startRow" = first data row (2 to skip header), "endRow" = last data row
- After creation, read the file to verify
