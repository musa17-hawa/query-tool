# Data Query Tool

Load any data file (CSV, XLSX, XLS, XML, JSON, TSV, SQLite `.db`/`.sqlite`, Access `.accdb`/`.mdb`) and query it with SQL — either by writing SQL directly or with a ServiceNow-style filter builder.

All parsing and querying happens in the browser using [sql.js](https://sql.js.org/) (SQLite compiled to WebAssembly) and, for Access files, [mdb-reader](https://www.npmjs.com/package/mdb-reader) (loaded lazily from a CDN). The Express server only serves the static files.

## Setup

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

## Troubleshooting Access (.accdb / .mdb) loading

The Access reader (`mdb-reader` + the `buffer` polyfill) is fetched on demand the first time you open an Access file. The app tries three CDNs in order — esm.sh, jsDelivr, and unpkg — and uses whichever one responds. You only see an error if all three are unreachable.

If you get "Could not load the Access-reader library":

1. **Network blocks all three CDNs.** Some corporate networks block ESM CDNs by default. Try from a different network, or ask IT to allowlist `esm.sh`, `cdn.jsdelivr.net`, and `unpkg.com`.
2. **You want it to work fully offline.** Vendor the library locally — download these two files into `public/vendor/`:
   ```bash
   mkdir -p public/vendor
   curl -L "https://esm.sh/buffer@6.0.3"             -o public/vendor/buffer.js
   curl -L "https://esm.sh/mdb-reader@3.2.0?bundle"  -o public/vendor/mdb-reader.js
   ```
   then at the top of `parseAccess`'s URL lists in `public/js/parser.js`, add `/vendor/buffer.js` and `/vendor/mdb-reader.js` as the first entry. Done — no more CDN calls.
3. **Wrong file.** Confirm the file is actually a `.accdb`/`.mdb` (not, say, a renamed CSV). Password-protected databases are also rejected — open them in Access, save without a password, and reload.

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
        ├── parser.js        # Reads CSV/XLSX/XML/JSON/SQLite/ACCDB into rows
        ├── database.js      # Wraps sql.js (load DB, run query, schema)
        ├── querybuilder.js  # ServiceNow-style filter UI
        └── app.js           # Wires everything together
```

## Supported file formats

| Format | Extensions | Notes |
| --- | --- | --- |
| SQLite | `.db`, `.sqlite`, `.sqlite3` | Loaded as-is, all tables preserved |
| Access | `.accdb`, `.mdb` | Read-only; each user table becomes a SQLite table |
| Excel | `.xlsx`, `.xls` | Each sheet becomes a table |
| CSV / TSV | `.csv`, `.tsv`, `.txt` | First row treated as headers |
| JSON | `.json` | Array of objects, or `{tableName: [...]}` |
| XML | `.xml` | Repeated child elements become rows |

## Picking which columns to show

Each table comes with a **Columns to show** chip strip. By default all columns are shown (`SELECT *`). Click a chip to drop that column from the result; click again to add it back. The **Show all** button resets to every column.

### Language quick-filter

If your dataset has parallel English / Hebrew columns (e.g. `title_english` and `title_hebrew`), use the **All / English only / Hebrew only** toggle next to the column picker:

- **English only** auto-selects every column whose name does *not* contain "hebrew".
- **Hebrew only** auto-selects every column whose name does *not* contain "english".
- **All** resets to showing every column.

The filter also restricts which fields are available in the condition dropdowns, so a filter built while "English only" is active can only reference English columns.

## Filter operators

Text: `field is exactly`, `field is not exactly`, `field will contain`, `field will not contain`, `field starts with`, `field ends with`, `field has no value`, `field has any value`, `field matches one of`, `field matches none of`

Number: `field is exactly`, `field is not exactly`, `field is greater than`, `field is less than`, `field is at least`, `field is at most`, `ranging between`, `field has no value`, `field has any value`

Conditions can be combined with **AND** / **OR**. The generated SQL is shown live and can be edited before running.

## Viewing results

Each result set can be viewed two ways via the **Table / Cards** toggle:

- **Table** view — Click any column header to sort by that column (cycles through ascending → descending → unsorted). The exported CSV reflects the current sort order.
- **Cards** view — Each row becomes a card with:
  - a **title** (first column matching *title* / *name* / *topic* / *subject*, or the first column),
  - a **date pill** in the top-right (first column matching *date*),
  - an optional **location row** with a 📍 marker (column named *address* / *location* / *city* etc.),
  - a **prominent description block** (column matching *description* / *body* / *content* / *notes* / *summary* / *details*…),
  - and the remaining fields as a label/value metadata footer.

## Use case

Built for storing and exploring book phrases and historical records about politicians and public figures, but works on any tabular dataset.
