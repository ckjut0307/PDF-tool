/* PDF 工具 v0.1 —— 网页 PDF 查看器 */
(function () {
  'use strict';

  // ---- Configure pdf.js ----
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  // ---- State ----
  const state = {
    pdf: null, // PDFDocumentProxy
    fileName: null,
    currentPage: 1,
    pageOrder: [], // physical page numbers in display order
    editMode: false,
    sourceBytes: null, // original file bytes for editing
    sourceFileName: null, // original name saved during editing
    scale: 1.0, // absolute zoom
    fitScale: 1.0, // scale that fits the page width
    baseScale: 1.0, // scale used to render at 100%
    renderedPages: new Map(), // pageNumber -> {canvas, task}
    renderSeq: 0, // to invalidate stale render tasks
  };

  // ---- DOM refs ----
  const viewerEl = document.getElementById('viewer');
  const emptyStateEl = document.getElementById('emptyState');
  const fileInput = document.getElementById('fileInput');
  const fileSelect = document.getElementById('fileSelect');
  const fileListEl = document.getElementById('fileList');
  const btnOpen = document.getElementById('btnOpen');
  const btnRefresh = document.getElementById('btnRefresh');
  const btnPrev = document.getElementById('btnPrev');
  const btnNext = document.getElementById('btnNext');
  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnZoomFit = document.getElementById('btnZoomFit');
  const pageInfo = document.getElementById('pageInfo');
  const zoomInfo = document.getElementById('zoomInfo');
  const pageJump = document.getElementById('pageJump');
  const statusEl = document.getElementById('status');
  const thumbPanel = document.getElementById('thumbPanel');
  const thumbList = document.getElementById('thumbList');
  const thumbCollapse = document.getElementById('thumbCollapse');
  const btnThumbToggle = document.getElementById('btnThumbToggle');
  const editMode = document.getElementById('editMode');
  const btnAddPdf = document.getElementById('btnAddPdf');
  const btnExport = document.getElementById('btnExport');
  const addPdfInput = document.getElementById('addPdfInput');

  // ============================================================
  //  URL helpers (force pdf.js to load via our own fetch/XHR so
  //  cross-origin issues are avoided and it works from file://)
  // ============================================================
  function loadPdfFromUrl(url, fileName) {
    return fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error('无法读取文件（HTTP ' + r.status + '）');
        return r.arrayBuffer();
      })
      .then((buf) => {
        const task = pdfjsLib.getDocument({ data: buf });
        return task.promise;
      })
      .then((pdf) => {
        openPdf(pdf, fileName || url);
      })
      .catch((err) => {
        setStatus('加载失败: ' + err.message);
        console.error(err);
      });
  }

  // ============================================================
  //  Open a document
  // ============================================================
  function openPdf(pdf, fileName) {
    state.pdf = pdf;
    state.fileName = fileName;
    state.sourceBytes = pdf._transport._data;
    state.sourceFileName = fileName;
    state.currentPage = 1;
    state.renderedPages.clear();
    state.renderSeq++; // kill old render tasks
    state.pageOrder = [];
    for (let i = 1; i <= pdf.numPages; i++) state.pageOrder.push(i);
    editMode.checked = false;
    state.editMode = false;
    document.body.classList.remove('edit-mode');
    btnAddPdf.disabled = false;
    btnExport.disabled = false;

    // clear viewer
    viewerEl.innerHTML = '';
    emptyStateEl.hidden = true;

    document.title = fileName + ' — PDF 工具';
    setStatus('已打开: ' + fileName + '（' + pdf.numPages + ' 页）');

    populatePageJump();
    updateNavButtons();
    buildThumbnails();
    if (localStorage.getItem('pdfToolThumbs') === '1') setThumbPanel(true);

    // Pre-build page DOM, then auto-fit to width
    buildPageElements().then(() => {
      computeFitScale();
      // fit on first open so the document is not too big / too small
      state.scale = state.fitScale;
      updateZoomLabel();
      renderVisible();
    });
  }

  function buildPageElements() {
    const frag = document.createDocumentFragment();
    state.pageOrder.forEach(function (phys) {
      const wrapper = document.createElement('div');
      wrapper.className = 'page';
      wrapper.id = 'page_' + phys;
      wrapper.dataset.phys = String(phys);
      const label = document.createElement('div');
      label.className = 'page-label';
      label.textContent = phys;
      const canvas = document.createElement('canvas');
      wrapper.appendChild(label);
      wrapper.appendChild(canvas);
      frag.appendChild(wrapper);
    });
    viewerEl.appendChild(frag);
    return Promise.resolve();
  }

  function computeFitScale() {
    const first = viewerEl.querySelector('.page');
    if (!first || !state.pdf) return;
    const p1 = state.pdf.getPage(1).then((page) => {
      const viewport = page.getViewport({ scale: 1 });
      const containerWidth = viewerEl.clientWidth;
      const paddingWidth = 40; // accounting for container padding
      state.baseScale = viewport.width;
      const fitScale = Math.max(0.1, (containerWidth - paddingWidth) / viewport.width);
      state.fitScale = fitScale;
      return Promise.resolve(page);
    });
    p1.then(() => {});
  }

  // ============================================================
  //  Rendering
  // ============================================================
  function renderPage(pageNum) {
    const wrapper = viewerEl.querySelector('#page_' + pageNum);
    if (!wrapper) return;
    const canvas = wrapper.querySelector('canvas');
    const label = wrapper.querySelector('.page-label');
    label.textContent = '第 ' + pageNum + ' 页';

    const seq = state.renderSeq;
    return state.pdf.getPage(pageNum).then((page) => {
      const viewport = page.getViewport({ scale: state.scale });
      const dpr = window.devicePixelRatio || 1;

      // size the page element so the layout doesn't jump
      wrapper.style.width = viewport.width + 'px';
      wrapper.style.height = viewport.height + 'px';
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = viewport.width + 'px';
      canvas.style.height = viewport.height + 'px';

      const renderContext = {
        canvasContext: canvas.getContext('2d'),
        viewport: viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      };

      return page
        .render(renderContext)
        .promise.then(() => {
          if (seq !== state.renderSeq) return; // stale
          wrapper.dataset.rendered = '1';
        })
        .catch((err) => {
          // Ignore "rendering cancelled" errors thrown on rapid zoom/scroll
          if (err && err.name !== 'RenderingCancelledException') {
            console.error('Render page ' + pageNum + ' error:', err);
          }
        });
    });
  }

  // Current viewport window in terms of page numbers (with margin)
  function visibleRange() {
    const container = document.querySelector('main');
    const rect = container.getBoundingClientRect();
    const margin = rect.height; // render one screen worth of buffer each way
    const top = rect.top - margin;
    const bottom = rect.bottom + margin;

    const pages = viewerEl.querySelectorAll('.page');
    let first = null,
      last = null;
    pages.forEach((pageEl) => {
      const r = pageEl.getBoundingClientRect();
      if (r.bottom < top || r.top > bottom) return;
      const n = parseInt(pageEl.dataset.phys, 10);
      if (first === null || n < first) first = n;
      if (last === null || n > last) last = n;
    });
    return { first: first || 1, last: last || 1 };
  }

  function renderVisible() {
    if (!state.pdf || !state.scale) return;
    const { first, last } = visibleRange();
    for (let i = first; i <= last; i++) {
      const wrapper = viewerEl.querySelector('#page_' + i);
      if (wrapper && wrapper.dataset.rendered !== '1') {
        renderPage(i);
      }
    }
  }

  // ============================================================
  //  Zoom
  // ============================================================
  function setZoom(scale, opts) {
    opts = opts || {};
    scale = Math.min(5, Math.max(0.1, round(scale)));

    if (opts.anchorPage) {
      // keep page offset stable
      const pageEl = viewerEl.querySelector('#page_' + opts.anchorPage);
      if (pageEl) {
        const oldRect = pageEl.getBoundingClientRect();
        state.scale = scale;
        requestAnimationFrame(() => {
          const newRect = pageEl.getBoundingClientRect();
          const dy = newRect.top - oldRect.top;
          scrollBy(0, dy);
        });
      } else {
        state.scale = scale;
      }
    } else {
      state.scale = scale;
    }

    state.renderedPages.clear();
    reapplySizes();
    updateZoomLabel();
  }

  function reapplySizes() {
    // Reset dataset so all pages re-render
    viewerEl.querySelectorAll('.page').forEach((p) => {
      p.dataset.rendered = '';
      p.style.width = '';
      p.style.height = '';
      const c = p.querySelector('canvas');
      // blank existing canvas to avoid stale visuals overlapping
      c.width = 1;
      c.height = 1;
    });
    renderVisible();
  }

  function updateZoomLabel() {
    zoomInfo.textContent = Math.round(state.scale * 100) + '%';
  }

  function round(v) {
    return Math.round(v * 100) / 100;
  }

  // ============================================================
  //  Page navigation
  // ============================================================
  function goToPage(n) {
    if (!state.pdf) return;
    n = Math.max(1, Math.min(state.pdf.numPages, n));
    state.currentPage = n;
    updateNavButtons();
    const el = viewerEl.querySelector('#page_' + n);
    if (el) {
      el.scrollIntoView({ block: 'start' });
    }
    renderVisible();
    updateThumbHighlight();
  }

  function currentPosition() {
    var i = state.pageOrder.indexOf(state.currentPage);
    return i < 0 ? 0 : i;
  }
  function nextPage() {
    var p = currentPosition() + 1;
    if (p < state.pageOrder.length) goToPage(state.pageOrder[p]);
  }
  function prevPage() {
    var p = currentPosition() - 1;
    if (p >= 0) goToPage(state.pageOrder[p]);
  }

  function updateNavButtons() {
    if (!state.pdf) {
      pageInfo.textContent = '– / –';
      btnPrev.disabled = true;
      btnNext.disabled = true;
      pageJump.disabled = true;
      return;
    }
    btnPrev.disabled = state.currentPage <= 1;
    btnNext.disabled = state.currentPage >= state.pdf.numPages;
    pageJump.disabled = false;
    pageInfo.textContent = state.currentPage + ' / ' + state.pdf.numPages;
    if (pageJump.value !== String(state.currentPage)) {
      pageJump.value = String(state.currentPage);
    }
  }

  function populatePageJump() {
    pageJump.innerHTML = '<option value="">页码</option>';
    for (let i = 1; i <= state.pdf.numPages; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = '第 ' + i + ' 页';
      pageJump.appendChild(opt);
    }
    pageJump.value = '1';
  }


  // ============================================================
  //  Thumbnails sidebar
  // ============================================================
  function buildThumbnails() {
    thumbList.innerHTML = '';
    const frag = document.createDocumentFragment();
    const thumbWidth = 150;
    const dpr = window.devicePixelRatio || 1;
    state.thumbItems = [];
    state.pageOrder.forEach(function (pageNum) {
      (function (pageNum) {
        const item = document.createElement('div');
        item.className = 'thumb-item';
        item.id = 'thumb_' + pageNum;
        item.setAttribute('data-phys', String(pageNum));
        item.draggable = true;
        const canvas = document.createElement('canvas');
        const label = document.createElement('div');
        label.className = 'thumb-label';
        label.textContent = String(pageNum);
        const del = document.createElement('button');
        del.className = 'thumb-del';
        del.title = '删除此页';
        del.textContent = '×';
        del.addEventListener('click', function () { deletePage(pageNum); });
        item.appendChild(del);
        item.appendChild(canvas);
        item.appendChild(label);
        frag.appendChild(item);
        state.thumbItems.push(item);

        state.pdf.getPage(pageNum).then(function (page) {
          const viewport = page.getViewport({ scale: 1 });
          const scale = thumbWidth / viewport.width;
          const vp = page.getViewport({ scale: scale });
          canvas.width = Math.floor(vp.width * dpr);
          canvas.height = Math.floor(vp.height * dpr);
          canvas.style.width = vp.width + 'px';
          canvas.style.height = vp.height + 'px';
          page.render({
            canvasContext: canvas.getContext('2d'),
            viewport: vp,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
          }).promise.catch(function (err) {
            if (err && err.name !== 'RenderingCancelledException') {
              console.error('Thumb ' + pageNum + ' error:', err);
            }
          });
        });
      })(pageNum);
    });
    thumbList.appendChild(frag);
    updateThumbHighlight();
    setupThumbDrag();
  }

  function updateThumbHighlight() {
    if (!state.thumbItems) return;
    state.thumbItems.forEach(function (it) {
      if (parseInt(it.dataset.phys, 10) === currentPhysicalPage()) {
        it.classList.add('active');
      } else {
        it.classList.remove('active');
      }
    });
  }

  function setThumbPanel(collapsed) {
    thumbPanel.classList.toggle('collapsed', collapsed);
    try {
      localStorage.setItem('pdfToolThumbs', collapsed ? '1' : '0');
    } catch (e) {}
  }


  // ============================================================
  //  Editing (page order / delete / add / export)
  // ============================================================
  function currentPhysicalPage() {
    // currentPage stores the physical page number currently shown
    if (!state.pdf || !state.pageOrder.length) return 1;
    if (state.pageOrder.indexOf(state.currentPage) < 0) return state.pageOrder[0];
    return state.currentPage;
  }

  // ---- Drag & drop on thumbnails ----
  function setupThumbDrag() {
    var items = thumbList.querySelectorAll('.thumb-item');
    items.forEach(function (item) {
      item.addEventListener('dragstart', function (e) {
        state.draggingPhys = parseInt(item.dataset.phys, 10);
        item.classList.add('dragging');
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(state.draggingPhys)); } catch (err) {}
      });
      item.addEventListener('dragend', function () {
        item.classList.remove('dragging');
        thumbList.querySelectorAll('.thumb-item').forEach(function (it) { it.classList.remove('drop-target'); });
        state.draggingPhys = null;
      });
      item.addEventListener('dragover', function (e) {
        e.preventDefault();
        if (!state.draggingPhys) return;
        thumbList.querySelectorAll('.thumb-item').forEach(function (it) { it.classList.remove('drop-target'); });
        item.classList.add('drop-target');
        try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
      });
      item.addEventListener('dragleave', function () { item.classList.remove('drop-target'); });
      item.addEventListener('drop', function (e) {
        e.preventDefault();
        var from = state.draggingPhys;
        var to = parseInt(item.dataset.phys, 10);
        if (from === to) { item.classList.remove('drop-target'); return; }
        movePage(from, to);
      });
    });
  }

  // Move the page whose physical number is `fromPhys` before/at `toPhys` in display order
  function movePage(fromPhys, toPhys) {
    var idxFrom = state.pageOrder.indexOf(fromPhys);
    var idxTo = state.pageOrder.indexOf(toPhys);
    if (idxFrom < 0 || idxTo < 0) return;
    state.pageOrder.splice(idxFrom, 1);
    // recompute idxTo after removal
    var idxTo2 = state.pageOrder.indexOf(toPhys);
    state.pageOrder.splice(idxTo2, 0, fromPhys);
    // fix current position if needed
    state.currentPage = Math.min(Math.max(1, state.currentPage), state.pageOrder.length);
    refreshAll();
  }

  // ---- Delete a page ----
  function deletePage(phys) {
    if (!state.pdf || state.pageOrder.length <= 1) {
      alert('至少要保留一页，无法删除。');
      return;
    }
    var ok = confirm('确定删除第 ' + phys + ' 页？');
    if (!ok) return;
    var idx = state.pageOrder.indexOf(phys);
    if (idx < 0) return;
    state.pageOrder.splice(idx, 1);
    if (state.currentPage > state.pageOrder.length) state.currentPage = state.pageOrder.length;
    refreshAll();
  }

  // ---- Re-render pages + thumbnails from current order ----
  function refreshAll() {
    var cp = currentPhysicalPage();
    // rebuild page DOM
    viewerEl.innerHTML = '';
    buildPageElements().then(function () {
      computeFitScale();
      state.scale = state.scale || state.fitScale;
      updateZoomLabel();
      renderVisible();
    });
    // rebuild thumbnails
    buildThumbnails();
    // update current position to point at same physical page
    var newPos = state.pageOrder.indexOf(cp);
    if (newPos >= 0) { state.currentPage = state.pageOrder[newPos]; }
    updateNavButtons();
    updateThumbHighlight();
  }

  function scrollToPhysical(phys) {
    var el = viewerEl.querySelector('#page_' + phys);
    if (el) el.scrollIntoView({ block: 'start' });
  }

  // ---- Editing UI ----
  editMode.addEventListener('change', function () {
    state.editMode = editMode.checked;
    if (editMode.checked) {
      document.body.classList.add('edit-mode');
      setStatus('编辑模式：可拖拽缩略图排序、点×删除页面，完成后点「导出」保存。');
    } else {
      document.body.classList.remove('edit-mode');
      setStatus('已关闭编辑模式。');
    }
  });

  addPdfInput.addEventListener('change', function () {
    var file = addPdfInput.files && addPdfInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { appendPdfBytes(new Uint8Array(reader.result)); };
    reader.readAsArrayBuffer(file);
    addPdfInput.value = '';
  });

  btnAddPdf.addEventListener('click', function () { addPdfInput.click(); });

  // Append a PDF (bytes) to the end of the current document
  function appendPdfBytes(u8) {
    var pdfLib = window.PDFLib || window.pdfLib;
    var i = 0;
    // progress-ish message
    setStatus('正在合并…');
    return pdfLib.PDFDocument.load(u8, { ignoreEncryption: true }).then(function (doc2) {
      var pdf = state.pdf;
      var total = doc2.getPageCount();
      function copyPage() {
        if (i >= total) {
          refreshAll();
          setStatus('已将读入文档 ' + doc2.getPageCount() + ' 页追加到末尾。');
          return;
        }
        return pdf.copyPage(doc2.getPage(i)).then(function (newPage) {
          pdf.addPage(newPage);
          i++;
          return copyPage();
        }).catch(function (e) {
          setStatus('合并失败: ' + e.message);
        });
      }
      return copyPage();
    }).catch(function (e) {
      setStatus('读取 PDF 失败: ' + e.message);
    });
  }

  // ---- Export ----
  btnExport.addEventListener('click', function () {
    if (!state.pdf) return;
    setStatus('正在导出…');
    buildPdfBlob().then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var base = (state.sourceFileName || 'document').replace(/\.pdf$/i, '');
      a.href = url;
      a.download = base + '_edited.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      setStatus('已导出: ' + a.download);
    }).catch(function (e) {
      setStatus('导出失败: ' + e.message);
      console.error(e);
    });
  });

  function buildPdfBlob() {
    var pdfLib = window.PDFLib || window.pdfLib;
    var order = state.pageOrder.slice();
    var src = state.sourceBytes || state.pdf._transport._data;
    return pdfLib.PDFDocument.load(src, { ignoreEncryption: true }).then(function (doc) {
      var out = pdfLib.PDFDocument.create();
      var copyNext = function (i) {
        if (i >= order.length) return out.save();
        return doc.copyPage(doc.getPage(order[i] - 1)).then(function (np) {
          out.addPage(np);
          return copyNext(i + 1);
        });
      };
      return copyNext(0).then(function (bytes) {
        return new Blob([bytes], { type: 'application/pdf' });
      });
    });
  }

  // ============================================================
  //  Tools / helpers
  // ============================================================
  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // ============================================================
  //  File panel
  // ============================================================
  function loadFileList(openName) {
    return fetch('/api/pdfs')
      .then((r) => r.json())
      .then((files) => {
        renderFileList(files);
        return files;
        if (openName) {
          loadPdfFromUrl('/api/pdf/' + encodeURIComponent(openName), openName);
        }
      })
      .catch((err) => {
        console.error('Failed to load file list', err);
        fileListEl.innerHTML = '<li class="file-list-empty">无法加载文件列表</li>';
      });
  }

  function renderFileList(files) {
    if (!files.length) {
      fileListEl.innerHTML =
        '<li class="file-list-empty">没有 PDF 文件。<br/>可将文件放入工具的 pdfs 文件夹后刷新。</li>';
      return;
    }
    fileListEl.innerHTML = '';
    // also populate the toolbar dropdown
    fileSelect.innerHTML = '<option value="">选择文件…</option>';
    fileSelect.hidden = false;

    files.forEach((f) => {
      // panel item
      const li = document.createElement('li');
      li.dataset.name = f.name;
      if (f.name === state.fileName) li.classList.add('active');

      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = f.name;

      const meta = document.createElement('span');
      meta.className = 'fmeta';
      meta.textContent = formatSize(f.size) + ' · ' + f.modified.slice(0, 10);

      li.appendChild(name);
      li.appendChild(meta);
      li.addEventListener('click', () => {
        document
          .querySelectorAll('.file-list li.active')
          .forEach((el) => el.classList.remove('active'));
        li.classList.add('active');
        openName(f.name);
      });
      fileListEl.appendChild(li);

      // dropdown option
      const opt = document.createElement('option');
      opt.value = f.name;
      opt.textContent = f.name;
      fileSelect.appendChild(opt);
    });
  }

  function openName(name) {
    setStatus('正在加载: ' + name);
    loadPdfFromUrl('/api/pdf/' + encodeURIComponent(name), name);
  }

  // ============================================================
  //  Events
  // ============================================================
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const task = pdfjsLib.getDocument({ data: reader.result });
      task.promise
        .then((pdf) => openPdf(pdf, file.name))
        .catch((err) => setStatus('加载失败: ' + err.message));
    };
    reader.readAsArrayBuffer(file);
    fileInput.value = '';
  });

  document.getElementById('btnOpen').addEventListener('click', () =>
    fileInput.click()
  );

  document.getElementById('btnRefresh').addEventListener('click', () =>
    loadFileList()
  );

  fileSelect.addEventListener('change', (e) => {
    if (e.target.value) openName(e.target.value);
  });

  btnPrev.addEventListener('click', prevPage);
  btnNext.addEventListener('click', nextPage);

  btnZoomIn.addEventListener('click', () =>
    setZoom(state.scale * 1.2, { anchorPage: currentVisiblePage() })
  );
  btnZoomOut.addEventListener('click', () =>
    setZoom(state.scale / 1.2, { anchorPage: currentVisiblePage() })
  );
  btnZoomFit.addEventListener('click', () =>
    setZoom(state.fitScale, { anchorPage: currentVisiblePage() })
  );

  pageJump.addEventListener('change', (e) => {
    if (e.target.value) goToPage(parseInt(e.target.value, 10));
  });

  // scroll -> re-render + update current page + page number
  let scrollTimer = null;
  document.getElementById('viewerContainer').addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      renderVisible();
      updateCurrentPageFromScroll();
    }, 60);
  });

  function updateCurrentPageFromScroll() {
    if (!state.pdf) return;
    const container = document.getElementById('viewerContainer');
    const mid = container.getBoundingClientRect().top + container.clientHeight * 0.3;
    let best = state.currentPage;
    let bestDist = Infinity;
    viewerEl.querySelectorAll('.page').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > container.clientHeight) return;
      const dist = Math.abs(r.top - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = parseInt(el.dataset.phys, 10);
      }
    });
    if (best !== state.currentPage) {
      state.currentPage = best;
      updateNavButtons();
      updateThumbHighlight();
    }
  }

  function currentVisiblePage() {
    return state.currentPage;
  }

  // Thumbnails sidebar events
  btnThumbToggle.addEventListener('click', function () {
    setThumbPanel(!thumbPanel.classList.contains('collapsed'));
  });
  thumbCollapse.addEventListener('click', function () {
    setThumbPanel(true);
  });

  // Mousewheel zoom with Ctrl
  document
    .getElementById('viewerContainer')
    .addEventListener('wheel', (e) => {
      if (!state.pdf) return;
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setZoom(state.scale * factor, { anchorPage: currentVisiblePage() });
    }, { passive: false });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (!state.pdf) return;
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault();
      nextPage();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      prevPage();
    } else if (e.key === 'Home') {
      e.preventDefault();
      goToPage(1);
    } else if (e.key === 'End') {
      e.preventDefault();
      goToPage(state.pdf.numPages);
    }
  });

  // Window resize -> re-fit
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => computeFitScale(), 200);
  });

  // ============================================================
  //  Init
  // ============================================================
  // automatically open first file if present
  loadFileList().then(function (files) {
    if (files && files.length) {
      openName(files[0].name);
    }
  });
})();
