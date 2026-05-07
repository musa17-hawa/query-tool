/* ============================================================
   app.js
   Top-level glue: file loading, schema browser, filter <-> SQL
   sync, query execution, results table.
   ============================================================ */
(function () {
  'use strict';

  // ---------- DOM refs -------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const fileInput     = $('file-input');
  const resetBtn      = $('reset-btn');
  const dropzone      = $('dropzone');
  const querySection  = $('query-section');
  const tableList     = $('table-list');
  const tableCount    = $('table-count');
  const columnsPanel  = $('columns-panel');
  const columnList    = $('column-list');
  const columnCount   = $('column-count');
  const activeTableSel = $('active-table');
  const filterHost    = $('filter-builder');
  const addCondBtn    = $('add-condition');
  const addOrBtn      = $('add-or');
  const clearFilterBtn = $('clear-filter');
  const sqlOutput     = $('sql-output');
  const toggleSqlEditBtn = $('toggle-sql-edit');
  const runBtn        = $('run-query');
  const resultMeta    = $('result-meta');
  const resultsHost   = $('results');
  const exportBtn     = $('export-csv');

  // ---------- state ----------------------------------------------------
  let activeTable = null;
  let manualSqlMode = false;
  let lastResult = null;       // last successful { columns, rows, ms }

  // ---------- query builder instance -----------------------------------
  const qb = new QueryBuilder(filterHost, { onChange: refreshSql });

  // ---------- file loading ---------------------------------------------
  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    await handleFiles(files);
    fileInput.value = '';
  });

  // drag-and-drop on the dropzone
  ['dragenter', 'dragover'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag-over'); });
  });
  dropzone.addEventListener('drop', async (e) => {
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) await handleFiles(files);
  });

  resetBtn.addEventListener('click', async () => {
    await DataDB.reset();
    activeTable = null;
    lastResult = null;
    qb.setColumns([]);
    refreshSchemaUI();
    refreshSql();
    resultsHost.innerHTML = '<p class="empty-hint">No query run yet. Build a filter above and hit <strong>Run query</strong>.</p>';
    resultMeta.textContent = '';
    exportBtn.disabled = true;
    dropzone.hidden = false;
    querySection.hidden = true;
    toast('Cleared all data.', 'success');
  });

  async function handleFiles(files) {
    try {
      await DataDB.init();
    } catch (err) {
      return toast('Failed to initialise SQL engine: ' + err.message, 'error');
    }

    let totalLoaded = 0;
    for (const f of files) {
      try {
        const parsed = await DataParser.parseFile(f);
        if (parsed.sqliteBuffer) {
          // Loading a SQLite file replaces the whole DB.
          await DataDB.loadSqliteBuffer(parsed.sqliteBuffer);
          const tables = DataDB.listTables();
          totalLoaded += tables.length;
          toast(`Loaded SQLite database (${tables.length} table${tables.length !== 1 ? 's' : ''}).`, 'success');
        } else if (parsed.tables) {
          for (const t of parsed.tables) {
            await DataDB.createTableFromRows(t.name, t.columns, t.rows);
            totalLoaded++;
          }
          const names = parsed.tables.map((t) => t.name).join(', ');
          toast(`Loaded ${parsed.tables.length} table${parsed.tables.length !== 1 ? 's' : ''}: ${names}`, 'success');
        }
      } catch (err) {
        console.error(err);
        toast(`Failed to load ${f.name}: ${err.message}`, 'error');
      }
    }

    if (totalLoaded > 0) {
      dropzone.hidden = true;
      querySection.hidden = false;
      // Default to the first table if none selected.
      const tables = DataDB.listTables();
      if (!activeTable || !tables.includes(activeTable)) {
        activeTable = tables[0];
      }
      refreshSchemaUI();
      onActiveTableChanged();
    }
  }

  // ---------- schema sidebar -------------------------------------------
  function refreshSchemaUI() {
    const tables = DataDB.listTables();
    tableCount.textContent = tables.length;

    // Sidebar table list
    tableList.innerHTML = '';
    if (!tables.length) {
      tableList.innerHTML = '<p class="empty-hint">No data loaded yet. Click <strong>Load file</strong> to begin.</p>';
      columnsPanel.hidden = true;
      activeTableSel.innerHTML = '';
      return;
    }
    tables.forEach((t) => {
      const item = document.createElement('div');
      item.className = 'table-item' + (t === activeTable ? ' active' : '');
      item.innerHTML = `
        <span class="table-item-name">
          <span class="table-item-icon">▦</span>
          <span>${escapeHtml(t)}</span>
        </span>
        <span class="table-item-rows">${DataDB.tableRowCount(t).toLocaleString()} rows</span>
      `;
      item.addEventListener('click', () => {
        activeTable = t;
        onActiveTableChanged();
      });
      tableList.appendChild(item);
    });

    // Top-of-panel <select> for active table
    activeTableSel.innerHTML = '';
    tables.forEach((t) => {
      const o = document.createElement('option');
      o.value = t; o.textContent = t;
      if (t === activeTable) o.selected = true;
      activeTableSel.appendChild(o);
    });

    // Column list for active table
    if (activeTable) {
      const cols = DataDB.schema(activeTable);
      columnsPanel.hidden = false;
      columnCount.textContent = cols.length;
      columnList.innerHTML = '';
      cols.forEach((c) => {
        const el = document.createElement('div');
        el.className = 'column-item';
        el.innerHTML = `
          <span>${escapeHtml(c.name)}</span>
          <span class="column-type">${escapeHtml(c.type)}</span>
        `;
        columnList.appendChild(el);
      });
    } else {
      columnsPanel.hidden = true;
    }
  }

  activeTableSel.addEventListener('change', () => {
    activeTable = activeTableSel.value;
    onActiveTableChanged();
  });

  function onActiveTableChanged() {
    if (!activeTable) return;
    const cols = DataDB.schema(activeTable);
    qb.setColumns(cols);
    qb.clear();
    refreshSchemaUI();
    refreshSql();
  }

  // ---------- filter <-> SQL sync --------------------------------------
  function refreshSql() {
    if (manualSqlMode) return; // user is editing manually; don't overwrite
    if (!activeTable) {
      sqlOutput.value = '';
      return;
    }
    const where = qb.buildWhere();
    const sql = `SELECT * FROM ${DataDB.quoteIdent(activeTable)}${where ? '\n' + where : ''}\nLIMIT 1000;`;
    sqlOutput.value = sql;
  }

  addCondBtn.addEventListener('click', () => qb.addRow('AND'));
  addOrBtn.addEventListener('click',   () => qb.addRow('OR'));
  clearFilterBtn.addEventListener('click', () => qb.clear());

  toggleSqlEditBtn.addEventListener('click', () => {
    manualSqlMode = !manualSqlMode;
    if (manualSqlMode) {
      sqlOutput.removeAttribute('readonly');
      toggleSqlEditBtn.textContent = 'Sync from filter';
      sqlOutput.focus();
      toast('SQL is now editable. Filter changes won’t overwrite it.', 'success');
    } else {
      sqlOutput.setAttribute('readonly', 'readonly');
      toggleSqlEditBtn.textContent = 'Edit manually';
      refreshSql();
    }
  });

  // ---------- run query -------------------------------------------------
  runBtn.addEventListener('click', () => {
    const sql = sqlOutput.value.trim();
    if (!sql) {
      toast('Nothing to run.', 'error');
      return;
    }
    try {
      const res = DataDB.run(sql);
      lastResult = res;
      renderResults(res);
      resultMeta.textContent = `${res.rowCount.toLocaleString()} row${res.rowCount !== 1 ? 's' : ''}` +
                               (res.ms ? ` in ${res.ms.toFixed(1)}ms` : '');
      exportBtn.disabled = res.rowCount === 0;
    } catch (err) {
      lastResult = null;
      resultsHost.innerHTML = `<pre class="results-error">${escapeHtml(err.message)}</pre>`;
      resultMeta.textContent = 'Error';
      exportBtn.disabled = true;
    }
  });

  // Cmd/Ctrl+Enter from the SQL textarea also runs.
  sqlOutput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      runBtn.click();
    }
  });

  // ---------- results table --------------------------------------------
  function renderResults(res) {
    if (!res.columns.length) {
      resultsHost.innerHTML = '<p class="empty-hint">Statement executed — no result set returned.</p>';
      return;
    }
    if (!res.rows.length) {
      resultsHost.innerHTML = '<p class="empty-hint">No rows matched.</p>';
      return;
    }

    const table = document.createElement('table');
    table.className = 'results-table';

    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    res.columns.forEach((c) => {
      const th = document.createElement('th');
      th.textContent = c;
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    // Render in batches if huge — but for now, sql.js runs already capped most.
    res.rows.forEach((r) => {
      const tr = document.createElement('tr');
      r.forEach((v) => {
        const td = document.createElement('td');
        if (v === null || v === undefined) {
          td.textContent = 'NULL';
          td.className = 'null';
        } else {
          td.textContent = String(v);
          td.title = String(v); // show full on hover
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    resultsHost.innerHTML = '';
    resultsHost.appendChild(table);
  }

  exportBtn.addEventListener('click', () => {
    if (!lastResult || !lastResult.rows.length) return;
    const csv = toCsv(lastResult.columns, lastResult.rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTable || 'results'}_${Date.now()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  function toCsv(columns, rows) {
    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const head = columns.map(escape).join(',');
    const body = rows.map((r) => r.map(escape).join(',')).join('\n');
    return head + '\n' + body;
  }

  // ---------- toast -----------------------------------------------------
  let toastTimer = null;
  function toast(msg, kind = '') {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // ---------- utils -----------------------------------------------------
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- kick off --------------------------------------------------
  DataDB.init().catch((err) => {
    toast('Failed to initialise SQL engine: ' + err.message, 'error');
  });
})();
