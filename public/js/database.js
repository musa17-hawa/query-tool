/* ============================================================
   database.js
   Thin wrapper around sql.js (SQLite-in-WASM).
   - lazily initialises sql.js
   - lets you create tables from {columns, rows}
   - lets you load an existing .db file
   - exposes .listTables(), .schema(table), .run(sql)
   ============================================================ */
(function (global) {
  'use strict';

  let SQL = null;          // sql.js module once loaded
  let db  = null;          // current SQLite database
  let initPromise = null;  // memoised init

  function init() {
    if (initPromise) return initPromise;
    initPromise = global.initSqlJs({
      locateFile: (f) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}`,
    }).then((mod) => {
      SQL = mod;
      db = new SQL.Database();
      return SQL;
    });
    return initPromise;
  }

  // ---------- create / load --------------------------------------------
  async function reset() {
    await init();
    if (db) try { db.close(); } catch (_) {}
    db = new SQL.Database();
  }

  // Replace the in-memory DB with the bytes of an uploaded SQLite file.
  // Existing tables are preserved exactly (column types, indexes, etc.).
  async function loadSqliteBuffer(uint8) {
    await init();
    if (db) try { db.close(); } catch (_) {}
    db = new SQL.Database(uint8);
  }

  // Create a table from parsed rows.  Columns are inferred from a sample.
  async function createTableFromRows(tableName, columns, rows) {
    await init();
    if (!db) db = new SQL.Database();

    const safeTable = quoteIdent(tableName);
    const types = inferColumnTypes(columns, rows);
    const colDefs = columns.map((c) => `${quoteIdent(c)} ${types[c]}`).join(', ');

    db.run(`DROP TABLE IF EXISTS ${safeTable};`);
    db.run(`CREATE TABLE ${safeTable} (${colDefs});`);

    if (!rows.length) return { table: tableName, inserted: 0 };

    // Bulk insert in a transaction for speed.
    db.run('BEGIN TRANSACTION;');
    try {
      const placeholders = columns.map(() => '?').join(', ');
      const insertSql = `INSERT INTO ${safeTable} VALUES (${placeholders});`;
      const stmt = db.prepare(insertSql);
      for (const row of rows) {
        const values = columns.map((c) => normaliseValue(row[c]));
        stmt.run(values);
      }
      stmt.free();
      db.run('COMMIT;');
    } catch (err) {
      db.run('ROLLBACK;');
      throw err;
    }

    return { table: tableName, inserted: rows.length };
  }

  // ---------- introspection --------------------------------------------
  function listTables() {
    if (!db) return [];
    const res = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
    );
    if (!res.length) return [];
    return res[0].values.map((r) => r[0]);
  }

  function tableRowCount(tableName) {
    if (!db) return 0;
    try {
      const res = db.exec(`SELECT COUNT(*) FROM ${quoteIdent(tableName)};`);
      return res.length ? res[0].values[0][0] : 0;
    } catch (_) { return 0; }
  }

  function schema(tableName) {
    if (!db) return [];
    const res = db.exec(`PRAGMA table_info(${quoteIdent(tableName)});`);
    if (!res.length) return [];
    // pragma columns: cid, name, type, notnull, dflt_value, pk
    return res[0].values.map((r) => ({ name: r[1], type: (r[2] || 'TEXT').toUpperCase() }));
  }

  // ---------- execution -------------------------------------------------
  // Returns { columns: [...], rows: [[...], ...], rowCount }
  function run(sql) {
    if (!db) throw new Error('No database loaded.');
    const trimmed = sql.trim();
    if (!trimmed) return { columns: [], rows: [], rowCount: 0 };

    const start = performance.now();
    const result = db.exec(trimmed);
    const ms = performance.now() - start;

    if (!result.length) return { columns: [], rows: [], rowCount: 0, ms };
    // db.exec returns one entry per statement; we use the last SELECT-shape result.
    const last = result[result.length - 1];
    return { columns: last.columns, rows: last.values, rowCount: last.values.length, ms };
  }

  // ---------- helpers ---------------------------------------------------
  // SQLite uses double-quotes for identifiers; double any internal quotes.
  function quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
  }

  // Decide a column's storage class from a sample of values.
  function inferColumnTypes(columns, rows) {
    const types = {};
    const sample = rows.slice(0, 200);
    for (const col of columns) {
      let allInt = true, allNum = true, anyVal = false;
      for (const r of sample) {
        const v = r[col];
        if (v === null || v === undefined || v === '') continue;
        anyVal = true;
        const s = String(v).trim();
        if (!/^-?\d+$/.test(s)) allInt = false;
        if (!/^-?\d+(\.\d+)?$/.test(s)) allNum = false;
        if (!allInt && !allNum) break;
      }
      if (!anyVal)       types[col] = 'TEXT';
      else if (allInt)   types[col] = 'INTEGER';
      else if (allNum)   types[col] = 'REAL';
      else               types[col] = 'TEXT';
    }
    return types;
  }

  // Convert a JS value into something sql.js can bind.
  function normaliseValue(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number')  return Number.isFinite(v) ? v : null;
    if (v instanceof Date)      return v.toISOString();
    if (typeof v === 'object')  return JSON.stringify(v);
    return String(v);
  }

  // ---------- export ----------------------------------------------------
  global.DataDB = {
    init, reset, loadSqliteBuffer, createTableFromRows,
    listTables, tableRowCount, schema, run,
    quoteIdent,
  };
})(window);
