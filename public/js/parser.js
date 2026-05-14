/* ============================================================
   parser.js
   Reads a File object and returns:
     { tables: [ { name, columns, rows } ] }
   where rows is an array of plain JS objects keyed by column.
   For SQLite files we instead return:
     { sqliteBuffer: Uint8Array }
   so database.js can load it natively (preserving all tables).
   ============================================================ */
(function (global) {
  'use strict';

  // ---------- public entry point ---------------------------------------
  async function parseFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const baseName = file.name.replace(/\.[^.]+$/, '');

    switch (ext) {
      case 'db':
      case 'sqlite':
      case 'sqlite3':
        return { sqliteBuffer: new Uint8Array(await file.arrayBuffer()) };

      case 'csv':
      case 'tsv':
      case 'txt':
        return { tables: [parseDelimited(await file.text(), baseName, ext)] };

      case 'xlsx':
      case 'xls':
        return { tables: parseExcel(await file.arrayBuffer(), baseName) };

      case 'json':
        return { tables: parseJson(await file.text(), baseName) };

      case 'xml':
        return { tables: [parseXml(await file.text(), baseName)] };

      case 'accdb':
      case 'mdb':
        return { tables: await parseAccess(await file.arrayBuffer(), baseName) };

      default:
        throw new Error(`Unsupported file extension: .${ext}`);
    }
  }

  // ---------- delimited (CSV / TSV) ------------------------------------
  function parseDelimited(text, name, ext) {
    const delimiter = ext === 'tsv' ? '\t' : ''; // '' lets PapaParse auto-detect
    const result = Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      delimiter,
      dynamicTyping: false, // keep everything as strings; type inference is handled later
    });
    if (result.errors && result.errors.length) {
      // Non-fatal — just log
      console.warn('CSV parse warnings:', result.errors.slice(0, 3));
    }
    const rows = result.data;
    const columns = result.meta.fields || (rows[0] ? Object.keys(rows[0]) : []);
    return { name: sanitizeName(name), columns, rows };
  }

  // ---------- Excel (XLSX / XLS) ---------------------------------------
  function parseExcel(arrayBuffer, baseName) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const tables = [];
    wb.SheetNames.forEach((sheetName) => {
      const sheet = wb.Sheets[sheetName];
      // defval: '' means empty cells become '' rather than missing keys
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
      if (!rows.length) return;
      const columns = collectColumns(rows);
      const tName = wb.SheetNames.length === 1
        ? sanitizeName(baseName)
        : sanitizeName(`${baseName}__${sheetName}`);
      tables.push({ name: tName, columns, rows });
    });
    if (!tables.length) {
      throw new Error('Workbook contains no readable sheets.');
    }
    return tables;
  }

  // ---------- JSON ------------------------------------------------------
  // Accepts either:
  //   [ {...}, {...} ]                       -> single table
  //   { "people": [...], "books": [...] }    -> one table per key
  function parseJson(text, baseName) {
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error('Invalid JSON: ' + e.message); }

    if (Array.isArray(data)) {
      return [{
        name: sanitizeName(baseName),
        columns: collectColumns(data),
        rows: flattenObjects(data),
      }];
    }
    if (data && typeof data === 'object') {
      const tables = [];
      for (const [key, val] of Object.entries(data)) {
        if (Array.isArray(val) && val.length && typeof val[0] === 'object') {
          tables.push({
            name: sanitizeName(key),
            columns: collectColumns(val),
            rows: flattenObjects(val),
          });
        }
      }
      if (tables.length) return tables;
    }
    throw new Error('JSON must be an array of objects, or an object whose values are arrays of objects.');
  }

  // ---------- XML -------------------------------------------------------
  // Heuristic: find the deepest element whose children are repeated tags;
  // each repeated child becomes a row, with its own children as columns.
  function parseXml(text, baseName) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const parseError = doc.querySelector('parsererror');
    if (parseError) throw new Error('Invalid XML: ' + parseError.textContent.split('\n')[0]);

    const root = doc.documentElement;
    const repeatedParent = findRepeatedChildrenParent(root) || root;

    const childTags = Array.from(repeatedParent.children).map((c) => c.tagName);
    const counts = {};
    childTags.forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
    const rowTag = Object.keys(counts).reduce((a, b) => (counts[a] >= counts[b] ? a : b), childTags[0]);

    const rowEls = Array.from(repeatedParent.children).filter((c) => c.tagName === rowTag);
    const rows = rowEls.map(elementToObject);
    const columns = collectColumns(rows);
    return { name: sanitizeName(baseName), columns, rows };
  }

  function findRepeatedChildrenParent(el) {
    if (!el || !el.children || el.children.length < 2) return null;
    const tags = Array.from(el.children).map((c) => c.tagName);
    const unique = new Set(tags);
    // If most children share a tag, we found our row container.
    if (tags.length >= 2 && unique.size <= Math.ceil(tags.length / 2)) return el;
    // Otherwise descend.
    for (const child of el.children) {
      const found = findRepeatedChildrenParent(child);
      if (found) return found;
    }
    return null;
  }

  function elementToObject(el) {
    const obj = {};
    // Attributes -> @attr
    for (const attr of el.attributes) obj['@' + attr.name] = attr.value;

    if (el.children.length === 0) {
      const t = el.textContent.trim();
      if (t) obj['#text'] = t;
      return obj;
    }
    for (const child of el.children) {
      const key = child.tagName;
      const val = child.children.length === 0
        ? child.textContent.trim()
        : elementToObject(child);
      // If the same tag repeats, collapse into JSON string (rare in flat tabular XML)
      if (obj[key] !== undefined) {
        if (!Array.isArray(obj[key])) obj[key] = [obj[key]];
        obj[key].push(val);
      } else {
        obj[key] = val;
      }
    }
    // Stringify any nested objects so they fit into a column
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] === 'object' && obj[k] !== null) {
        obj[k] = JSON.stringify(obj[k]);
      }
    }
    return obj;
  }

  // ---------- Access (ACCDB / MDB) -------------------------------------
  // Uses `mdb-reader` (pure JS, no native deps) loaded lazily the first
  // time the user drops an Access file. Read-only.
  //
  // mdb-reader's browser bundle expects Node-style `Buffer` objects (it
  // calls `.copy()`, `.readUInt16LE()`, etc.), which plain Uint8Arrays
  // don't have. So we also load the `buffer` polyfill and wrap the file
  // bytes in a real Buffer before handing them off.

  let _mdbReaderPromise = null;

  // Try each URL in order; resolve with the first successful import.
  async function tryImport(urls, label) {
    let lastErr;
    for (const url of urls) {
      try {
        return await import(url);
      } catch (err) {
        lastErr = err;
        console.warn(`[parser] ${label}: import failed for ${url} →`, err && err.message);
      }
    }
    const wrapped = new Error(`Could not load ${label} from any CDN.`);
    wrapped.cause = lastErr;
    throw wrapped;
  }

  function loadMdbReader() {
    if (_mdbReaderPromise) return _mdbReaderPromise;
    _mdbReaderPromise = (async () => {
      // 1. Buffer polyfill — needed to construct Node-style Buffers in the
      //    browser. esm.sh and jsdelivr both host the standard `buffer` pkg.
      const bufferMod = await tryImport([
        'https://esm.sh/buffer@6.0.3',
        'https://cdn.jsdelivr.net/npm/buffer@6.0.3/+esm',
        'https://unpkg.com/buffer@6.0.3/index.js',
      ], 'Buffer polyfill');
      const BufferCtor = bufferMod.Buffer || (bufferMod.default && bufferMod.default.Buffer);
      if (typeof BufferCtor !== 'function') {
        throw new Error('Buffer polyfill loaded but no `Buffer` export found.');
      }
      // Expose globally so mdb-reader's bundled code can find it if its own
      // bundling didn't inline the polyfill.
      if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = BufferCtor;

      // 2. mdb-reader itself (browser bundle, with deps bundled in via ?bundle).
      const mdbMod = await tryImport([
        'https://esm.sh/mdb-reader@3.2.0?bundle',
        'https://cdn.jsdelivr.net/npm/mdb-reader@3.2.0/+esm',
        'https://esm.sh/mdb-reader@3?bundle',
      ], 'mdb-reader');
      const MDBReader = mdbMod.default || mdbMod.MDBReader || mdbMod;
      if (typeof MDBReader !== 'function') {
        throw new Error('mdb-reader loaded but no constructor was exported.');
      }
      return { MDBReader, Buffer: BufferCtor };
    })();
    return _mdbReaderPromise;
  }

  async function parseAccess(arrayBuffer, baseName) {
    let MDBReader, Buffer;
    try {
      ({ MDBReader, Buffer } = await loadMdbReader());
    } catch (err) {
      const cause = (err && err.cause) ? (err.cause.message || String(err.cause)) : '';
      throw new Error(
        'Could not load the Access-reader library. This usually means you are ' +
        'offline, or your network blocks all three of esm.sh, jsdelivr, and ' +
        'unpkg. Try a different network — or vendor mdb-reader locally as ' +
        'described in the README. ' +
        (cause ? ('Underlying error: ' + cause) : '')
      );
    }

    let reader;
    try {
      // Convert the file bytes into a Node-style Buffer so mdb-reader's
      // internal calls (.copy / .readUInt16LE / .slice) work.
      const buf = Buffer.from(new Uint8Array(arrayBuffer));
      reader = new MDBReader(buf);
    } catch (err) {
      throw new Error(
        'This file could not be opened as an Access database (.accdb / .mdb). ' +
        'It may be corrupt, password-protected, or in an unsupported format. ' +
        'Underlying error: ' + (err && err.message ? err.message : String(err))
      );
    }

    const tableNames = reader.getTableNames();
    if (!tableNames.length) {
      throw new Error('Access database contains no user tables.');
    }

    const tables = [];
    for (const tName of tableNames) {
      let t;
      try { t = reader.getTable(tName); }
      catch (_) { continue; } // skip tables we can't read (e.g. linked / unsupported)

      // Use getColumns() when available (mdb-reader exposes full Column objects);
      // fall back to getColumnNames() for forward-compat with any API tweak.
      let columns;
      if (typeof t.getColumns === 'function') {
        columns = t.getColumns().map((c) => c.name);
      } else if (typeof t.getColumnNames === 'function') {
        columns = t.getColumnNames();
      } else {
        continue;
      }

      const rawRows = t.getData(); // array of plain objects keyed by column name
      // Normalise: dates -> ISO strings, nested objects -> JSON, so each value
      // can be stored in a SQLite column without losing information.
      const rows = rawRows.map((r) => {
        const out = {};
        for (const k of columns) {
          const v = r[k];
          if (v instanceof Date)                out[k] = v.toISOString();
          else if (v && typeof v === 'object')  out[k] = JSON.stringify(v);
          else                                  out[k] = v;
        }
        return out;
      });
      const finalName = tableNames.length === 1
        ? sanitizeName(baseName)
        : sanitizeName(`${baseName}__${tName}`);
      tables.push({ name: finalName, columns, rows });
    }

    if (!tables.length) {
      throw new Error('Access database could not be read (no supported tables).');
    }
    return tables;
  }

  // ---------- helpers ---------------------------------------------------
  function collectColumns(rows) {
    const seen = new Set();
    const cols = [];
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      for (const k of Object.keys(r)) {
        if (!seen.has(k)) { seen.add(k); cols.push(k); }
      }
    }
    return cols;
  }

  // Flatten nested objects/arrays in JSON rows to JSON strings so they fit
  // into a SQL column without losing information.
  function flattenObjects(rows) {
    return rows.map((r) => {
      if (!r || typeof r !== 'object') return { value: r };
      const out = {};
      for (const [k, v] of Object.entries(r)) {
        out[k] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
      }
      return out;
    });
  }

  // Make a string safe to use as a SQL identifier (table or column name).
  function sanitizeName(raw) {
    let n = String(raw).replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    if (!n) n = 'data';
    if (/^\d/.test(n)) n = '_' + n;
    return n;
  }

  // ---------- export ----------------------------------------------------
  global.DataParser = { parseFile, sanitizeName, collectColumns };
})(window);
