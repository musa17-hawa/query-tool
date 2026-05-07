# Data Query Tool

Load any data file (CSV, XLSX, XLS, XML, JSON, TSV, SQLite `.db`/`.sqlite`) and query it with SQL — either by writing SQL directly or with a ServiceNow-style filter builder (AND / OR / contains / is empty / etc.).

All parsing and querying happens in the browser using [sql.js](https://sql.js.org/) (SQLite compiled to WebAssembly). The Express server only serves the static files.

## Setup

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

## Project structure

```
data-query-tool/
├── server.js            # Express static server
├── package.json
└── public/
    ├── index.html
    ├── css/
    │   └── styles.css
    └── js/
        ├── parser.js        # Reads CSV/XLSX/XML/JSON/SQLite into rows
        ├── database.js      # Wraps sql.js (load DB, run query, schema)
        ├── querybuilder.js  # ServiceNow-style filter UI
        └── app.js           # Wires everything together
```

## Supported file formats

| Format | Extensions | Notes |
| --- | --- | --- |
| SQLite | `.db`, `.sqlite`, `.sqlite3` | Loaded as-is, all tables preserved |
| Excel | `.xlsx`, `.xls` | Each sheet becomes a table |
| CSV / TSV | `.csv`, `.tsv`, `.txt` | First row treated as headers |
| JSON | `.json` | Array of objects, or `{tableName: [...]}` |
| XML | `.xml` | Repeated child elements become rows |

## Filter operators

Text: `is`, `is not`, `contains`, `does not contain`, `starts with`, `ends with`, `is empty`, `is not empty`, `is one of`, `is not one of`

Number: `=`, `!=`, `>`, `<`, `>=`, `<=`, `between`, `is empty`, `is not empty`

Conditions can be combined with **AND** / **OR**. The generated SQL is shown live and can be edited before running.

## Use case

Built for storing and exploring book phrases and historical records about politicians and public figures, but works on any tabular dataset.
