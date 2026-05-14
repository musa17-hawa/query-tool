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
  const columnChips   = $('column-chips');
  const colsSelectAll = $('cols-select-all');
  const viewTableBtn  = $('view-table');
  const viewCardsBtn  = $('view-cards');
  const langAllBtn    = $('lang-all');
  const langEnBtn     = $('lang-en');
  const langHeBtn     = $('lang-he');
  const resultsTips   = $('results-tips');
  const cardModal     = $('card-modal');
  const cardModalBody = $('card-modal-body');
  const cardModalClose= $('card-modal-close');
  const cardModalPrev = $('card-modal-prev');
  const cardModalNext = $('card-modal-next');
  const cardModalCount= $('card-modal-counter');

  // ---------- state ----------------------------------------------------
  let activeTable = null;
  let manualSqlMode = false;
  let lastResult = null;       // last successful { columns, rows, ms }
  let selectedCols = [];       // columns user wants to display; [] means "all visible"
  let sortState = { col: null, dir: null }; // dir: 'asc' | 'desc' | null
  let viewMode = 'table';      // 'table' | 'cards'
  let languageFilter = 'all';  // 'all' | 'english' | 'hebrew'
  let columnOrder = [];        // display order of columns (array of column names)
  let modalRowIndex = -1;      // index into sorted rows for the currently-open detail

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
    selectedCols = [];
    sortState = { col: null, dir: null };
    columnOrder = [];
    languageFilter = 'all';
    langAllBtn.classList.add('active');
    langEnBtn.classList.remove('active');
    langHeBtn.classList.remove('active');
    qb.setColumns([]);
    refreshSchemaUI();
    renderColumnPicker();
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
    qb.setColumns(visibleSchemaCols(cols));
    qb.clear();
    // When switching tables, default to "all visible columns".
    selectedCols = [];
    renderColumnPicker();
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
    const selectList = buildSelectList();
    const sql = `SELECT ${selectList} FROM ${DataDB.quoteIdent(activeTable)}${where ? '\n' + where : ''}\nLIMIT 1000;`;
    sqlOutput.value = sql;
  }

  // Build the comma-separated column list for SELECT. If the user hasn't
  // picked any columns, or has picked every visible column, emit "*".
  function buildSelectList() {
    if (!activeTable) return '*';
    const visible = visibleColumnNames();
    if (!visible.length) return '*';
    // No specific selection, or selection == every visible column -> use *
    if (!selectedCols.length || selectedCols.length === visible.length) {
      // When the language filter is active and hides some columns, we still
      // need to emit the explicit list so we don't accidentally SELECT the
      // hidden-language columns.
      if (languageFilter === 'all') return '*';
      return visible.map((c) => DataDB.quoteIdent(c)).join(', ');
    }
    return selectedCols.map((c) => DataDB.quoteIdent(c)).join(', ');
  }

  // ---------- language filter ------------------------------------------
  // A column is "visible" if it matches the current language filter.
  function matchesLanguage(colName) {
    const n = String(colName).toLowerCase();
    if (languageFilter === 'english') return !n.includes('hebrew');
    if (languageFilter === 'hebrew')  return !n.includes('english');
    return true;
  }
  function visibleColumnNames() {
    if (!activeTable) return [];
    return DataDB.schema(activeTable).map((c) => c.name).filter(matchesLanguage);
  }
  function visibleSchemaCols(schemaCols) {
    return schemaCols.filter((c) => matchesLanguage(c.name));
  }

  function setLanguage(lang) {
    languageFilter = lang;
    // Update button states
    [['all', langAllBtn], ['english', langEnBtn], ['hebrew', langHeBtn]].forEach(([k, btn]) => {
      const on = (k === lang);
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (!activeTable) return;
    // Reset column selection to "all visible" so the chips reflect the filter
    // (the user's previous custom selection is intentionally discarded — clicking
    // a language preset is itself a selection action).
    selectedCols = [];
    // Filter the conditions' field dropdown to visible columns; QB drops any
    // existing conditions referencing a now-hidden column.
    qb.setColumns(visibleSchemaCols(DataDB.schema(activeTable)));
    renderColumnPicker();
    refreshSql();
  }

  langAllBtn.addEventListener('click', () => setLanguage('all'));
  langEnBtn .addEventListener('click', () => setLanguage('english'));
  langHeBtn .addEventListener('click', () => setLanguage('hebrew'));

  // ---------- column picker --------------------------------------------
  function renderColumnPicker() {
    columnChips.innerHTML = '';
    if (!activeTable) return;
    const cols = visibleColumnNames();
    if (!cols.length) {
      const note = document.createElement('p');
      note.className = 'column-picker-empty';
      note.textContent = `No columns match the current language filter (${languageFilter}).`;
      columnChips.appendChild(note);
      return;
    }
    const selSet = new Set(selectedCols);
    const showingAll = selectedCols.length === 0 || selectedCols.length === cols.length;
    cols.forEach((name) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      const isOn = showingAll || selSet.has(name);
      chip.className = 'col-chip' + (isOn ? ' on' : '');
      chip.textContent = name;
      chip.title = isOn ? 'Click to hide this column' : 'Click to show this column';
      chip.addEventListener('click', () => {
        // First click while "all" is implicit -> seed selection with everything then toggle.
        let next = selectedCols.length === 0 ? cols.slice() : selectedCols.slice();
        if (next.includes(name)) next = next.filter((c) => c !== name);
        else                     next.push(name);
        // Preserve schema order
        selectedCols = cols.filter((c) => next.includes(c));
        renderColumnPicker();
        refreshSql();
      });
      columnChips.appendChild(chip);
    });
  }

  colsSelectAll.addEventListener('click', () => {
    selectedCols = []; // empty == all visible
    renderColumnPicker();
    refreshSql();
  });

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
    runBtn.classList.add('running');
    runBtn.disabled = true;
    // Defer one frame so the spinner actually paints before sql.js blocks.
    requestAnimationFrame(() => {
      try {
        const res = DataDB.run(sql);
        lastResult = res;
        sortState = { col: null, dir: null }; // fresh query -> unsorted
        columnOrder = res.columns.slice();    // fresh query -> reset to natural order
        renderResults();
        resultMeta.textContent = `${res.rowCount.toLocaleString()} row${res.rowCount !== 1 ? 's' : ''}` +
                                 (res.ms ? ` in ${res.ms.toFixed(1)}ms` : '');
        exportBtn.disabled = res.rowCount === 0;
      } catch (err) {
        lastResult = null;
        resultsHost.innerHTML = `<pre class="results-error">${escapeHtml(err.message)}</pre>`;
        resultMeta.textContent = 'Error';
        exportBtn.disabled = true;
      } finally {
        runBtn.classList.remove('running');
        runBtn.disabled = false;
      }
    });
  });

  // Cmd/Ctrl+Enter from the SQL textarea also runs.
  sqlOutput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      runBtn.click();
    }
  });

  // ---------- results --------------------------------------------------
  function renderResults() {
    if (!lastResult) {
      resultsHost.innerHTML = '<p class="empty-hint">No query run yet. Build a filter above and hit <strong>Run query</strong>.</p>';
      resultsTips.hidden = true;
      return;
    }
    const res = lastResult;
    if (!res.columns.length) {
      resultsHost.innerHTML = '<p class="empty-hint">Statement executed — no result set returned.</p>';
      resultsTips.hidden = true;
      return;
    }
    if (!res.rows.length) {
      resultsHost.innerHTML = '<p class="empty-hint">No rows matched.</p>';
      resultsTips.hidden = true;
      return;
    }
    // Tip line: visible only when we actually have rows on screen.
    resultsTips.hidden = false;
    resultsTips.dataset.mode = viewMode;
    const rows = sortedRows(res);
    resultsHost.innerHTML = '';
    if (viewMode === 'cards') {
      resultsHost.appendChild(renderCards(res.columns, rows));
    } else {
      resultsHost.appendChild(renderTable(res.columns, rows));
    }
  }

  // Sort the latest result rows by the current sortState. We keep this
  // entirely client-side so toggling sort doesn't re-run the SQL.
  function sortedRows(res) {
    if (!sortState.col || !sortState.dir) return res.rows;
    const idx = res.columns.indexOf(sortState.col);
    if (idx < 0) return res.rows;
    const dir = sortState.dir === 'desc' ? -1 : 1;
    const copy = res.rows.slice();
    copy.sort((a, b) => compareCells(a[idx], b[idx]) * dir);
    return copy;
  }

  function compareCells(a, b) {
    // Nulls always sort last (regardless of direction feels less surprising).
    const aNull = a === null || a === undefined || a === '';
    const bNull = b === null || b === undefined || b === '';
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  // Resolve the display order. Returns an array of {name, srcIdx} where
  // srcIdx is the column's original index inside res.columns (which is what
  // each row tuple is keyed by). Falls back to natural order if columnOrder
  // is stale (e.g. a column was renamed between queries).
  function orderedColumns(srcColumns) {
    const seen = new Set();
    const out = [];
    for (const name of columnOrder) {
      const idx = srcColumns.indexOf(name);
      if (idx >= 0 && !seen.has(name)) {
        out.push({ name, srcIdx: idx });
        seen.add(name);
      }
    }
    // Append any columns missing from columnOrder (defensive).
    srcColumns.forEach((name, idx) => {
      if (!seen.has(name)) out.push({ name, srcIdx: idx });
    });
    return out;
  }

  function renderTable(columns, rows) {
    const table = document.createElement('table');
    table.className = 'results-table';

    const display = orderedColumns(columns);
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');

    // Track whether a real drag happened, so we don't sort after a drop.
    let dragSource = null;
    let dragMoved  = false;

    display.forEach(({ name }, displayIdx) => {
      const th = document.createElement('th');
      th.className = 'sortable draggable-th';
      th.draggable = true;
      th.dataset.col = name;
      th.dataset.displayIdx = String(displayIdx);

      const isSorted = sortState.col === name;
      if (isSorted) th.classList.add('sorted-' + sortState.dir);

      // grip icon (visual affordance for drag)
      const grip = document.createElement('span');
      grip.className = 'th-grip';
      grip.setAttribute('aria-hidden', 'true');
      grip.innerHTML = '⋮⋮';

      const label = document.createElement('span');
      label.className = 'th-label';
      label.textContent = name;

      const indicator = document.createElement('span');
      indicator.className = 'sort-indicator';
      indicator.textContent = isSorted ? (sortState.dir === 'asc' ? '▲' : '▼') : '↕';

      th.append(grip, label, indicator);
      th.title = `Click to sort by ${name}  •  Drag to reorder`;

      // ---- click -> sort (suppressed if a drag just happened) ----
      th.addEventListener('click', () => {
        if (dragMoved) return;
        if (sortState.col !== name)         sortState = { col: name, dir: 'asc' };
        else if (sortState.dir === 'asc')   sortState = { col: name, dir: 'desc' };
        else if (sortState.dir === 'desc')  sortState = { col: null, dir: null };
        else                                sortState = { col: name, dir: 'asc' };
        renderResults();
      });

      // ---- drag start ----
      th.addEventListener('dragstart', (e) => {
        dragSource = name;
        dragMoved  = false;
        th.classList.add('dragging');
        try {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', name);
        } catch (_) {}
      });

      // ---- drag over (allow drop + show insertion indicator) ----
      th.addEventListener('dragover', (e) => {
        if (!dragSource || dragSource === name) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        dragMoved = true;
        // Insert before this column if cursor on left half, otherwise after.
        const rect = th.getBoundingClientRect();
        const before = (e.clientX - rect.left) < rect.width / 2;
        // Clear other indicators
        trh.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
          el.classList.remove('drop-before', 'drop-after');
        });
        th.classList.add(before ? 'drop-before' : 'drop-after');
      });

      th.addEventListener('dragleave', () => {
        th.classList.remove('drop-before', 'drop-after');
      });

      // ---- drop ----
      th.addEventListener('drop', (e) => {
        if (!dragSource || dragSource === name) return;
        e.preventDefault();
        const rect = th.getBoundingClientRect();
        const before = (e.clientX - rect.left) < rect.width / 2;
        moveColumn(dragSource, name, before);
        renderResults();
      });

      // ---- drag end (cleanup) ----
      th.addEventListener('dragend', () => {
        th.classList.remove('dragging');
        trh.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((el) => {
          el.classList.remove('drop-before', 'drop-after', 'dragging');
        });
        // Reset flag after this tick so any spurious click can read it first.
        setTimeout(() => { dragSource = null; dragMoved = false; }, 0);
      });

      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((r, rowIdx) => {
      const tr = document.createElement('tr');
      tr.dataset.rowIdx = String(rowIdx);
      display.forEach(({ srcIdx }) => {
        const v = r[srcIdx];
        const td = document.createElement('td');
        if (v === null || v === undefined) {
          td.textContent = 'NULL';
          td.className = 'null';
        } else {
          td.textContent = String(v);
          td.title = String(v);
        }
        tr.appendChild(td);
      });
      // Click anywhere on a row to open the detail modal (consistent UX
      // with cards). Use mousedown-to-mouseup distance check so users can
      // still select text without accidentally opening the modal.
      let downX = null, downY = null;
      tr.addEventListener('mousedown', (e) => { downX = e.clientX; downY = e.clientY; });
      tr.addEventListener('mouseup',   (e) => {
        if (downX === null) return;
        const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
        downX = downY = null;
        if (moved > 4) return; // user was selecting text -> don't open
        // Avoid stealing clicks from the th (drag) — only open on tbody rows.
        openCardDetail(rowIdx);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  // Move column `src` to before/after column `target` in columnOrder.
  function moveColumn(src, target, before) {
    if (src === target) return;
    const order = columnOrder.slice();
    const sIdx = order.indexOf(src);
    if (sIdx < 0) return;
    order.splice(sIdx, 1);
    let tIdx = order.indexOf(target);
    if (tIdx < 0) tIdx = order.length;
    order.splice(before ? tIdx : tIdx + 1, 0, src);
    columnOrder = order;
  }

  // Pick a "title-ish" column for cards: looks for names like title/name/
  // topic/subject; otherwise falls back to the first column.
  function pickTitleCol(columns) {
    const wanted = ['title', 'name', 'topic', 'subject', 'heading'];
    const lc = columns.map((c) => c.toLowerCase());
    for (const w of wanted) {
      const i = lc.findIndex((c) => c === w || c.endsWith('_' + w) || c.startsWith(w + '_'));
      if (i >= 0) return columns[i];
    }
    return columns[0];
  }

  // Pick a "date-ish" column for the card subtitle, if any.
  function pickDateCol(columns) {
    const lc = columns.map((c) => c.toLowerCase());
    const i = lc.findIndex((c) => c === 'date' || c.endsWith('_date') || c.startsWith('date_') || c.includes('date'));
    return i >= 0 ? columns[i] : null;
  }

  // Pick a "description-ish" column for the card body. Multiple synonyms
  // because real-world schemas vary a lot.
  function pickDescCol(columns) {
    const synonyms = ['description', 'desc', 'body', 'content', 'text',
                      'notes', 'note', 'summary', 'comment', 'comments',
                      'details', 'detail', 'excerpt', 'abstract', 'message'];
    const lc = columns.map((c) => c.toLowerCase());
    // Exact / suffix / prefix match first
    for (const w of synonyms) {
      const i = lc.findIndex((c) => c === w || c.endsWith('_' + w) || c.startsWith(w + '_'));
      if (i >= 0) return columns[i];
    }
    // Then any-position match (covers e.g. "description_english")
    for (const w of synonyms) {
      const i = lc.findIndex((c) => c.includes(w));
      if (i >= 0) return columns[i];
    }
    return null;
  }

  // Pick a "location-ish" column (Address, Location, Place, City, Country).
  function pickLocationCol(columns) {
    const synonyms = ['address', 'location', 'place', 'city', 'country', 'region'];
    const lc = columns.map((c) => c.toLowerCase());
    for (const w of synonyms) {
      const i = lc.findIndex((c) => c === w || c.includes(w));
      if (i >= 0) return columns[i];
    }
    return null;
  }

  function renderCards(columns, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'results-cards';

    const titleCol = pickTitleCol(columns);
    const dateCol  = pickDateCol(columns);
    const descCol  = pickDescCol(columns);
    const locCol   = pickLocationCol(columns);
    const titleIdx = columns.indexOf(titleCol);
    const dateIdx  = dateCol ? columns.indexOf(dateCol) : -1;
    const descIdx  = descCol ? columns.indexOf(descCol) : -1;
    const locIdx   = locCol  ? columns.indexOf(locCol)  : -1;

    rows.forEach((r, rowIdx) => {
      const card = document.createElement('article');
      card.className = 'result-card result-card-clickable';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', 'View full details for ' + formatCell(r[titleIdx]));
      if (descIdx < 0) card.classList.add('no-desc');

      // ----- header: title + optional date pill -----
      const head = document.createElement('header');
      head.className = 'result-card-head';
      const title = document.createElement('h3');
      title.className = 'result-card-title';
      title.textContent = formatCell(r[titleIdx]);
      title.title = formatCell(r[titleIdx]);
      head.appendChild(title);
      if (dateIdx >= 0 && dateIdx !== titleIdx) {
        const sub = document.createElement('span');
        sub.className = 'result-card-date';
        sub.textContent = formatCell(r[dateIdx]);
        head.appendChild(sub);
      }
      card.appendChild(head);

      // ----- location row (Address / City / etc.) under the header -----
      if (locIdx >= 0 && locIdx !== titleIdx && locIdx !== dateIdx) {
        const loc = document.createElement('div');
        loc.className = 'result-card-location';
        const icon = document.createElement('span');
        icon.className = 'result-card-location-icon';
        icon.textContent = '📍';
        const text = document.createElement('span');
        text.textContent = formatCell(r[locIdx]);
        loc.append(icon, text);
        card.appendChild(loc);
      }

      // ----- description teaser (clamped) -----
      if (descIdx >= 0) {
        const desc = document.createElement('p');
        desc.className = 'result-card-desc-teaser';
        const v = r[descIdx];
        if (v === null || v === undefined || v === '') {
          desc.textContent = 'No ' + descCol.toLowerCase() + '.';
          desc.classList.add('null');
        } else {
          desc.textContent = String(v);
        }
        card.appendChild(desc);
      }

      // ----- footer: "View details" hint -----
      const footer = document.createElement('div');
      footer.className = 'result-card-footer';
      const usedSet = new Set([titleIdx, dateIdx, descIdx, locIdx].filter((i) => i >= 0));
      const moreCount = columns.length - usedSet.size;
      const moreText = moreCount > 0
        ? `+${moreCount} more field${moreCount === 1 ? '' : 's'}`
        : 'View details';
      const moreLabel = document.createElement('span');
      moreLabel.className = 'result-card-more';
      moreLabel.textContent = moreText;
      const arrow = document.createElement('span');
      arrow.className = 'result-card-arrow';
      arrow.innerHTML = '→';
      footer.append(moreLabel, arrow);
      card.appendChild(footer);

      // ----- click / keyboard activation -----
      card.addEventListener('click', () => openCardDetail(rowIdx));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openCardDetail(rowIdx);
        }
      });

      wrap.appendChild(card);
    });
    return wrap;
  }

  // ---------- card detail modal (zoom view) ----------------------------
  // Opens the row with the given index in the *currently displayed* (sorted)
  // result. Keeps modalRowIndex so prev/next can walk through the result.
  function openCardDetail(rowIdx) {
    if (!lastResult) return;
    const sorted = sortedRows(lastResult);
    if (rowIdx < 0 || rowIdx >= sorted.length) return;
    modalRowIndex = rowIdx;
    renderCardDetail();
    cardModal.hidden = false;
    cardModal.setAttribute('aria-hidden', 'false');
    // Force a reflow so the .open transition actually plays.
    void cardModal.offsetWidth;
    cardModal.classList.add('open');
    // Lock body scroll while open.
    document.body.classList.add('modal-open');
    // Focus the close button for keyboard users.
    setTimeout(() => cardModalClose.focus(), 50);
  }

  function closeCardDetail() {
    cardModal.classList.remove('open');
    cardModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    // Hide after the transition so focus / tab order is correct.
    setTimeout(() => { if (!cardModal.classList.contains('open')) cardModal.hidden = true; }, 200);
    modalRowIndex = -1;
  }

  function stepCardDetail(delta) {
    if (!lastResult) return;
    const sorted = sortedRows(lastResult);
    const next = modalRowIndex + delta;
    if (next < 0 || next >= sorted.length) return;
    modalRowIndex = next;
    renderCardDetail();
  }

  function renderCardDetail() {
    if (!lastResult || modalRowIndex < 0) return;
    const res = lastResult;
    const sorted = sortedRows(res);
    const row = sorted[modalRowIndex];
    if (!row) return;

    const columns = res.columns;
    const titleCol = pickTitleCol(columns);
    const dateCol  = pickDateCol(columns);
    const descCol  = pickDescCol(columns);
    const locCol   = pickLocationCol(columns);
    const titleIdx = columns.indexOf(titleCol);
    const dateIdx  = dateCol ? columns.indexOf(dateCol) : -1;
    const descIdx  = descCol ? columns.indexOf(descCol) : -1;
    const locIdx   = locCol  ? columns.indexOf(locCol)  : -1;
    const used = new Set([titleIdx, dateIdx, descIdx, locIdx].filter((i) => i >= 0));

    // Build the modal body fresh each step.
    cardModalBody.innerHTML = '';

    // Eyebrow with row number ("Result 3 of 47")
    const eyebrow = document.createElement('div');
    eyebrow.className = 'card-modal-eyebrow';
    eyebrow.textContent = `Result ${modalRowIndex + 1} of ${sorted.length}`;
    cardModalBody.appendChild(eyebrow);

    // Title (set on the dialog for aria-labelledby)
    const titleEl = document.createElement('h2');
    titleEl.id = 'card-modal-title';
    titleEl.className = 'card-modal-title';
    titleEl.textContent = formatCell(row[titleIdx]);
    cardModalBody.appendChild(titleEl);

    // Meta row: date pill + location
    const meta = document.createElement('div');
    meta.className = 'card-modal-meta';
    if (dateIdx >= 0 && dateIdx !== titleIdx) {
      const d = document.createElement('span');
      d.className = 'card-modal-date';
      d.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1v2M12 1v2M2 6h12M3 3h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1z" stroke="currentColor" stroke-width="1.3" fill="none"/></svg> ';
      const t = document.createElement('span');
      t.textContent = formatCell(row[dateIdx]);
      d.appendChild(t);
      meta.appendChild(d);
    }
    if (locIdx >= 0 && locIdx !== titleIdx && locIdx !== dateIdx) {
      const l = document.createElement('span');
      l.className = 'card-modal-location';
      l.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1c2.8 0 5 2.2 5 5 0 3.5-5 9-5 9S3 9.5 3 6c0-2.8 2.2-5 5-5z" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="8" cy="6" r="1.7" fill="currentColor"/></svg> ';
      const t = document.createElement('span');
      t.textContent = formatCell(row[locIdx]);
      l.appendChild(t);
      meta.appendChild(l);
    }
    if (meta.childNodes.length) cardModalBody.appendChild(meta);

    // Big description (full text, scrollable inside the modal body).
    if (descIdx >= 0) {
      const descLabel = document.createElement('div');
      descLabel.className = 'card-modal-section-label';
      descLabel.textContent = descCol;
      const desc = document.createElement('div');
      desc.className = 'card-modal-desc';
      const v = row[descIdx];
      if (v === null || v === undefined || v === '') {
        desc.textContent = 'No ' + descCol.toLowerCase() + '.';
        desc.classList.add('null');
      } else {
        desc.textContent = String(v);
      }
      cardModalBody.append(descLabel, desc);
    }

    // All remaining fields in a grid (using user's columnOrder).
    const display = orderedColumns(columns);
    const remaining = display.filter(({ srcIdx }) => !used.has(srcIdx));
    if (remaining.length) {
      const allLabel = document.createElement('div');
      allLabel.className = 'card-modal-section-label';
      allLabel.textContent = 'All fields';
      cardModalBody.appendChild(allLabel);

      const grid = document.createElement('dl');
      grid.className = 'card-modal-grid';
      remaining.forEach(({ name, srcIdx }) => {
        const dt = document.createElement('dt');
        dt.textContent = name;
        const dd = document.createElement('dd');
        const v = row[srcIdx];
        if (v === null || v === undefined || v === '') {
          dd.textContent = '—';
          dd.classList.add('null');
        } else {
          dd.textContent = String(v);
        }
        grid.append(dt, dd);
      });
      cardModalBody.appendChild(grid);
    }

    // Update prev/next button states and counter
    cardModalPrev.disabled = (modalRowIndex === 0);
    cardModalNext.disabled = (modalRowIndex >= sorted.length - 1);
    cardModalCount.textContent = `${modalRowIndex + 1} / ${sorted.length}`;
  }

  // Modal event wiring
  cardModalClose.addEventListener('click', closeCardDetail);
  cardModalPrev .addEventListener('click', () => stepCardDetail(-1));
  cardModalNext .addEventListener('click', () => stepCardDetail(+1));
  cardModal.addEventListener('click', (e) => {
    if (e.target.dataset && e.target.dataset.close === '1') closeCardDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (cardModal.hidden) return;
    if (e.key === 'Escape')     { e.preventDefault(); closeCardDetail(); }
    else if (e.key === 'ArrowLeft')  { stepCardDetail(-1); }
    else if (e.key === 'ArrowRight') { stepCardDetail(+1); }
  });

  function formatCell(v) {
    if (v === null || v === undefined || v === '') return '—';
    return String(v);
  }

  // ---------- view toggle ----------------------------------------------
  function setViewMode(mode) {
    viewMode = mode;
    viewTableBtn.classList.toggle('active', mode === 'table');
    viewCardsBtn.classList.toggle('active', mode === 'cards');
    viewTableBtn.setAttribute('aria-selected', mode === 'table' ? 'true' : 'false');
    viewCardsBtn.setAttribute('aria-selected', mode === 'cards' ? 'true' : 'false');
    renderResults();
  }
  viewTableBtn.addEventListener('click', () => setViewMode('table'));
  viewCardsBtn.addEventListener('click', () => setViewMode('cards'));

  exportBtn.addEventListener('click', () => {
    if (!lastResult || !lastResult.rows.length) return;
    const rows = sortedRows(lastResult);
    // Honour the user's column order in the exported file.
    const display = orderedColumns(lastResult.columns);
    const headers = display.map((d) => d.name);
    const reordered = rows.map((r) => display.map(({ srcIdx }) => r[srcIdx]));
    const csv = toCsv(headers, reordered);
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
