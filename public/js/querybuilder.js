/* ============================================================
   querybuilder.js
   A ServiceNow-style condition builder.
   - Each row: AND/OR | field | operator | value(s) | remove
   - First row's connector is hidden (no preceding clause).
   - Renders to a host element and emits "change" via callback.
   - Produces a SQL WHERE clause via .buildWhere().
   ============================================================ */
(function (global) {
  'use strict';

  // ---------- operator catalogue ---------------------------------------
  // Each operator declares: label, value-arity (0 / 1 / 2 / many),
  // applicable type ('any' | 'number' | 'text'), and a renderer to SQL.
  const OPERATORS = [
    { id: 'eq',        label: 'field is exactly',          arity: 1, types: ['any'],
      sql: (col, vals) => `${col} = ${literal(vals[0])}` },
    { id: 'neq',       label: 'field is not exactly',      arity: 1, types: ['any'],
      sql: (col, vals) => `${col} <> ${literal(vals[0])}` },
    { id: 'contains',  label: 'field will contain',        arity: 1, types: ['text', 'any'],
      sql: (col, vals) => `${col} LIKE ${literal('%' + String(vals[0] ?? '') + '%')}` },
    { id: 'ncontains', label: 'field will not contain',    arity: 1, types: ['text', 'any'],
      sql: (col, vals) => `(${col} NOT LIKE ${literal('%' + String(vals[0] ?? '') + '%')} OR ${col} IS NULL)` },
    { id: 'starts',    label: 'field starts with',         arity: 1, types: ['text', 'any'],
      sql: (col, vals) => `${col} LIKE ${literal(String(vals[0] ?? '') + '%')}` },
    { id: 'ends',      label: 'field ends with',           arity: 1, types: ['text', 'any'],
      sql: (col, vals) => `${col} LIKE ${literal('%' + String(vals[0] ?? ''))}` },
    { id: 'gt',        label: 'field is greater than',     arity: 1, types: ['number', 'any'],
      sql: (col, vals) => `${col} > ${numberOrLiteral(vals[0])}` },
    { id: 'lt',        label: 'field is less than',        arity: 1, types: ['number', 'any'],
      sql: (col, vals) => `${col} < ${numberOrLiteral(vals[0])}` },
    { id: 'gte',       label: 'field is at least',         arity: 1, types: ['number', 'any'],
      sql: (col, vals) => `${col} >= ${numberOrLiteral(vals[0])}` },
    { id: 'lte',       label: 'field is at most',          arity: 1, types: ['number', 'any'],
      sql: (col, vals) => `${col} <= ${numberOrLiteral(vals[0])}` },
    { id: 'between',   label: 'ranging between',           arity: 2, types: ['number', 'any'],
      sql: (col, vals) => `${col} BETWEEN ${numberOrLiteral(vals[0])} AND ${numberOrLiteral(vals[1])}` },
    { id: 'empty',     label: 'field has no value',        arity: 0, types: ['any'],
      sql: (col)       => `(${col} IS NULL OR ${col} = '')` },
    { id: 'nempty',    label: 'field has any value',       arity: 0, types: ['any'],
      sql: (col)       => `(${col} IS NOT NULL AND ${col} <> '')` },
    { id: 'in',        label: 'field matches one of',      arity: 'list', types: ['any'],
      sql: (col, vals) => `${col} IN (${vals.map(literal).join(', ')})` },
    { id: 'nin',       label: 'field matches none of',     arity: 'list', types: ['any'],
      sql: (col, vals) => `${col} NOT IN (${vals.map(literal).join(', ')})` },
  ];

  function literal(v) {
    if (v === null || v === undefined) return 'NULL';
    return "'" + String(v).replace(/'/g, "''") + "'";
  }
  function numberOrLiteral(v) {
    if (v === '' || v === null || v === undefined) return 'NULL';
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : literal(v);
  }

  // ---------- main builder ---------------------------------------------
  class QueryBuilder {
    constructor(host, opts = {}) {
      this.host = host;
      this.onChange = opts.onChange || (() => {});
      this.columns = []; // [{ name, type }]
      this.rows = [];    // [{ id, connector, field, operator, values: [] }]
    }

    setColumns(columns) {
      this.columns = columns;
      // Drop any rows that reference columns no longer present.
      const names = new Set(columns.map((c) => c.name));
      this.rows = this.rows.filter((r) => names.has(r.field));
      this.render();
    }

    addRow(connector = 'AND') {
      if (!this.columns.length) return;
      const first = this.columns[0];
      this.rows.push({
        id: crypto.randomUUID ? crypto.randomUUID() : 'r' + Math.random().toString(36).slice(2),
        connector,
        field: first.name,
        operator: 'eq',
        values: [''],
      });
      this.render();
      this.onChange();
    }

    clear() {
      this.rows = [];
      this.render();
      this.onChange();
    }

    // Build "WHERE ..." (or "" if no rows). Always parenthesises each cond.
    buildWhere() {
      if (!this.rows.length) return '';
      const fragments = this.rows.map((r, i) => {
        const op = OPERATORS.find((o) => o.id === r.operator);
        if (!op) return null;
        const colSql = quoteIdent(r.field);
        let vals = r.values || [];
        if (op.arity === 0)        vals = [];
        else if (op.arity === 'list') vals = splitList(vals[0]);
        const cond = '(' + op.sql(colSql, vals) + ')';
        return i === 0 ? cond : `${r.connector} ${cond}`;
      }).filter(Boolean);
      return fragments.length ? 'WHERE ' + fragments.join(' ') : '';
    }

    // ---------- rendering ----------------------------------------------
    render() {
      this.host.innerHTML = '';
      this.rows.forEach((row, idx) => {
        this.host.appendChild(this._renderRow(row, idx));
      });
    }

    _renderRow(row, idx) {
      const el = document.createElement('div');
      el.className = 'condition-row';
      el.dataset.id = row.id;

      // connector toggle (AND/OR)
      const conn = document.createElement('button');
      conn.type = 'button';
      conn.className = 'connector ' + (idx === 0 ? 'first' : row.connector.toLowerCase());
      conn.textContent = row.connector;
      conn.title = 'Click to toggle AND/OR';
      conn.addEventListener('click', () => {
        row.connector = row.connector === 'AND' ? 'OR' : 'AND';
        this.render();
        this.onChange();
      });
      el.appendChild(conn);

      // field selector
      const fieldSel = document.createElement('select');
      fieldSel.className = 'select';
      this.columns.forEach((c) => {
        const o = document.createElement('option');
        o.value = c.name; o.textContent = c.name;
        if (c.name === row.field) o.selected = true;
        fieldSel.appendChild(o);
      });
      fieldSel.addEventListener('change', () => {
        row.field = fieldSel.value;
        // reset operator if the new field's type doesn't support it
        const newCol = this.columns.find((c) => c.name === row.field);
        const ops = applicableOperators(newCol);
        if (!ops.find((o) => o.id === row.operator)) {
          row.operator = ops[0].id;
          row.values = [''];
        }
        this.render();
        this.onChange();
      });
      el.appendChild(fieldSel);

      // operator selector
      const col = this.columns.find((c) => c.name === row.field);
      const ops = applicableOperators(col);
      const opSel = document.createElement('select');
      opSel.className = 'select';
      ops.forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o.id; opt.textContent = o.label;
        if (o.id === row.operator) opt.selected = true;
        opSel.appendChild(opt);
      });
      opSel.addEventListener('change', () => {
        row.operator = opSel.value;
        const op = OPERATORS.find((o) => o.id === row.operator);
        if (op.arity === 0) row.values = [];
        else if (op.arity === 2 && row.values.length < 2) row.values = ['', ''];
        else if (op.arity === 1 && row.values.length === 0) row.values = [''];
        this.render();
        this.onChange();
      });
      el.appendChild(opSel);

      // value input (varies with operator)
      const op = OPERATORS.find((o) => o.id === row.operator);
      el.appendChild(this._renderValueInput(row, op));

      // remove button
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn-danger-ghost';
      rm.title = 'Remove condition';
      rm.textContent = '✕';
      rm.addEventListener('click', () => {
        this.rows = this.rows.filter((r) => r.id !== row.id);
        this.render();
        this.onChange();
      });
      el.appendChild(rm);

      return el;
    }

    _renderValueInput(row, op) {
      // 0-arity ops (is empty / is not empty) get a placeholder spacer.
      if (op.arity === 0) {
        const spacer = document.createElement('div');
        spacer.className = 'input value-hidden';
        return spacer;
      }
      // BETWEEN -> two inputs joined by "and"
      if (op.arity === 2) {
        const wrap = document.createElement('div');
        wrap.className = 'input between-pair';
        const a = document.createElement('input');
        a.type = 'text'; a.value = row.values[0] ?? '';
        a.placeholder = 'min';
        a.addEventListener('input', () => {
          row.values[0] = a.value; this.onChange();
        });
        const sep = document.createElement('span');
        sep.textContent = 'and';
        const b = document.createElement('input');
        b.type = 'text'; b.value = row.values[1] ?? '';
        b.placeholder = 'max';
        b.addEventListener('input', () => {
          row.values[1] = b.value; this.onChange();
        });
        wrap.append(a, sep, b);
        return wrap;
      }
      // single-value or comma-list -> one text input
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'input';
      input.value = row.values[0] ?? '';
      input.placeholder = op.arity === 'list' ? 'value1, value2, value3' : 'value';
      input.addEventListener('input', () => {
        row.values[0] = input.value;
        this.onChange();
      });
      return input;
    }
  }

  // ---------- helpers ---------------------------------------------------
  function applicableOperators(column) {
    const t = inferKind(column);
    return OPERATORS.filter((o) => o.types.includes('any') || o.types.includes(t));
  }
  function inferKind(column) {
    if (!column) return 'any';
    const t = (column.type || '').toUpperCase();
    if (t.includes('INT') || t.includes('REAL') || t.includes('NUM') || t.includes('FLOAT') || t.includes('DOUB'))
      return 'number';
    return 'text';
  }
  function splitList(raw) {
    if (raw === undefined || raw === null) return [];
    return String(raw).split(',').map((s) => s.trim()).filter((s) => s.length);
  }
  function quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
  }

  // ---------- export ----------------------------------------------------
  global.QueryBuilder = QueryBuilder;
})(window);
