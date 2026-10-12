/* PDF 宸ュ叿 v0.2 -- PDF viewer & editor */
(function () {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  var PDFLib = window.PDFLib || window.pdfLib;

  var state = {
    docs: {}, order: [], current: null, currentPage: 1,
    scale: 1.0, fitScale: 1.0,
    clip: null, orgOpen: false, orgSel: new Set(),
    renderSeq: 0, _id: 0
  };

  function $id(i) { return document.getElementById(i); }
  var viewerEl = $id('viewer');
  var fileInput = $id('fileInput');
  var pageInfo = $id('pageInfo');
  var jump = $id('pageJump');
  var zoomInfo = $id('zoomInfo');
  var statusEl = $id('status');
  var thumbPanel = $id('thumbPanel');
  var thumbList = $id('thumbList');
  var thumbCollapse = $id('thumbCollapse');
  var tabBar = $id('tabBar');
  var ov = $id('organizeOverlay');
  var orgGrid = $id('organizeGrid');
  var orgDoc = $id('organizeDoc');
  var orgHint = $id('orgHint');

  function setStatus(m) { statusEl.textContent = m; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function activeDoc() { return state.docs[state.current] || null; }

  function addDoc(name) {
    state._id++;
    var id = 'd' + state._id;
    state.docs[id] = { id: id, name: name, bytes: null, pdf: null, pageOrder: [], dirty: false };
    state.order.push(id);
    return id;
  }

  function ingest(id, bytes) {
    var d = state.docs[id];
    // \u4fdd\u6301\u4e00\u4efd\u72ec\u7acb\u526f\u672c\uff0c\u907f\u514d pdf.js \u89e3\u6790\u65f6\u62d6\u79bb(\u4f20\u9001)buffer\u5bfc\u81f4\u5373\u5c06\u4e0d\u53ef\u7528
    var keep = new Uint8Array(bytes);
    d.bytes = keep;
    d.pageOrder = []; d.dirty = true;
    return pdfjsLib.getDocument({ data: new Uint8Array(keep) }).promise.then(function (pdf) {
      d.pdf = pdf;
      for (var i = 1; i <= pdf.numPages; i++) d.pageOrder.push(i);
      d.dirty = false;
      return id;
    });
  }

  function openFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    var ids = [], chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        return new Promise(function (resolve) {
          var reader = new FileReader();
          reader.onload = function () {
            var id = addDoc(f.name);
            ingest(id, new Uint8Array(reader.result)).then(function (did) { ids.push(did); resolve(); });
          };
          reader.readAsArrayBuffer(f);
        });
      });
    });
    return chain.then(function () {
      if (ids.length) {
        state.current = ids[ids.length - 1];
        state.currentPage = 1;
        renderTabs();
        refreshAll();
        setStatus('\u5df2\u6253\u5f00 ' + ids.length + ' \u4e2a\u6587\u6863');
      }
    });
  }

  function buildPages() {
    viewerEl.innerHTML = '';
    var d = activeDoc();
    if (!d) return;
    var frag = document.createDocumentFragment();
    d.pageOrder.forEach(function (p) {
      var w = document.createElement('div');
      w.className = 'page';
      w.id = 'page_' + d.id + '_' + p;
      w.dataset.phys = String(p);
      var label = document.createElement('div');
      label.className = 'page-label';
      label.textContent = '\u7b2c ' + p + ' \u9875';
      var canvas = document.createElement('canvas');
      w.appendChild(label);
      w.appendChild(canvas);
      frag.appendChild(w);
    });
    viewerEl.appendChild(frag);
  }

  function calcFit() {
    var d = activeDoc();
    if (!d) return;
    d.pdf.getPage(1).then(function (pg) {
      var v = pg.getViewport({ scale: 1 });
      var cw = viewerEl.clientWidth || 800;
      state.fitScale = Math.max(0.05, (cw - 40) / v.width);
    });
  }

  function renderPg(d, p) {
    var w = viewerEl.querySelector('#page_' + d.id + '_' + p);
    if (!w) return;
    var c = w.querySelector('canvas');
    var seq = state.renderSeq;
    return d.pdf.getPage(p).then(function (pg) {
      var v = pg.getViewport({ scale: state.scale });
      var dr = window.devicePixelRatio || 1;
      w.style.width = v.width + 'px';
      c.width = Math.floor(v.width * dr);
      c.height = Math.floor(v.height * dr);
      c.style.width = v.width + 'px';
      c.style.height = v.height + 'px';
      return pg.render({
        canvasContext: c.getContext('2d'),
        viewport: v,
        transform: dr !== 1 ? [dr, 0, 0, dr, 0, 0] : null
      }).promise.then(function () {
        if (seq === state.renderSeq) w.dataset.rendered = '1';
      }).catch(function () {});
    });
  }

  function renderVisible() {
    var d = activeDoc();
    if (!d) return;
    var ct = $id('viewerContainer');
    var rt = ct.getBoundingClientRect();
    var top = rt.top - rt.height, bot = rt.bottom + rt.height;
    viewerEl.querySelectorAll('.page').forEach(function (w) {
      var r = w.getBoundingClientRect();
      if (r.bottom < top || r.top > bot) return;
      if (w.dataset.rendered !== '1') renderPg(d, parseInt(w.dataset.phys, 10));
    });
  }

  function paintThumb(d, p, c) {
    d.pdf.getPage(p).then(function (pg) {
      var v = pg.getViewport({ scale: 1 });
      var s = 150 / v.width;
      var v2 = pg.getViewport({ scale: s });
      var dr = window.devicePixelRatio || 1;
      c.width = Math.floor(v2.width * dr);
      c.height = Math.floor(v2.height * dr);
      c.style.width = v2.width + 'px';
      pg.render({ canvasContext: c.getContext('2d'), viewport: v2, transform: dr !== 1 ? [dr, 0, 0, dr, 0, 0] : null }).promise.catch(function () {});
    });
  }

  function buildThumbs() {
    thumbList.innerHTML = '';
    var d = activeDoc();
    if (!d) return;
    var frag = document.createDocumentFragment();
    d.pageOrder.forEach(function (p) {
      var it = document.createElement('div');
      it.className = 'thumb-item';
      it.id = 'thumb_' + d.id + '_' + p;
      it.dataset.phys = String(p);
      var c = document.createElement('canvas');
      var lab = document.createElement('div');
      lab.className = 'thumb-label';
      lab.textContent = '#' + p;
      it.appendChild(c);
      it.appendChild(lab);
      frag.appendChild(it);
      paintThumb(d, p, c);
      it.addEventListener('click', function () { goToPage(p); });
    });
    thumbList.appendChild(frag);
    updThumbHL();
  }

  function updThumbHL() {
    var d = activeDoc();
    if (!d) return;
    thumbList.querySelectorAll('.thumb-item').forEach(function (it) {
      it.classList.toggle('active', parseInt(it.dataset.phys, 10) === curPage());
    });
  }

  function setThumbPanel(c) {
    thumbPanel.classList.toggle('collapsed', !!c);
    try { localStorage.setItem('pdfToolThumbs', c ? '1' : '0'); } catch (e) {}
  }

  function curPage() {
    var d = activeDoc();
    if (!d || !d.pageOrder.length) return 1;
    var p = state.currentPage - 1;
    if (p < 0 || p >= d.pageOrder.length) return d.pageOrder[0];
    return d.pageOrder[p];
  }

  function goToPage(phys) {
    var d = activeDoc();
    if (!d) return;
    var idx = d.pageOrder.indexOf(phys);
    if (idx < 0) return;
    state.currentPage = idx + 1;
    updNav();
    var el = viewerEl.querySelector('#page_' + d.id + '_' + phys);
    if (el) el.scrollIntoView({ block: 'start' });
    renderVisible();
    updThumbHL();
  }

  function nextPage() {
    var d = activeDoc();
    if (!d || !d.pageOrder.length || state.currentPage >= d.pageOrder.length) return;
    goToPage(d.pageOrder[state.currentPage]);
  }
  function prevPage() {
    if (state.currentPage <= 1) return;
    var d = activeDoc();
    if (!d) return;
    goToPage(d.pageOrder[state.currentPage - 2]);
  }

  function updNav() {
    var d = activeDoc();
    if (!d) {
      pageInfo.textContent = '- / -';
      jump.disabled = true;
      $id('btnPrev').disabled = true;
      $id('btnNext').disabled = true;
      $id('btnOrganize').disabled = true;
      $id('btnExport').disabled = true;
      $id('btnSave').disabled = true;
      $id('btnSaveAs').disabled = true;
      return;
    }
    $id('btnPrev').disabled = state.currentPage <= 1;
    $id('btnNext').disabled = state.currentPage >= d.pageOrder.length;
    jump.disabled = !d.pageOrder.length;
    $id('btnOrganize').disabled = false;
    $id('btnExport').disabled = false;
    $id('btnSave').disabled = false;
    $id('btnSaveAs').disabled = false;
    pageInfo.textContent = d.pageOrder.length ? (state.currentPage + ' / ' + d.pageOrder.length) : '0 / 0';
    if (jump.value !== String(curPage())) jump.value = String(curPage());
  }

  function setZoom(s) {
    s = Math.min(5, Math.max(0.05, r2(s)));
    var c = curPage();
    state.scale = s;
    state.renderSeq++;
    buildPages();
    calcFit();
    zoomInfo.textContent = Math.round(s * 100) + '%';
    goToPage(c);
  }

  function refreshAll() {
    buildPages();
    calcFit();
    renderVisible();
    buildThumbs();
    updNav();
  }

  function copySel() {
    var d = activeDoc();
    if (!d || !state.orgSel.size) { setStatus('\u8bf7\u5148\u9009\u62e9\u9875\u9762'); return; }
    state.clip = { bytes: d.bytes, pages: Array.from(state.orgSel), cut: false };
    setStatus('\u5df2\u590d\u5236 ' + state.orgSel.size + ' \u9875');
  }
  function cutSel() {
    var d = activeDoc();
    if (!d || !state.orgSel.size) { setStatus('\u8bf7\u5148\u9009\u62e9\u9875\u9762'); return; }
    state.clip = { bytes: d.bytes, pages: Array.from(state.orgSel), cut: true, srcId: d.id };
    setStatus('\u5df2\u526a\u5207 ' + state.orgSel.size + ' \u9875\uff0c\u53ef\u7c98\u8d34\u5230\u5176\u4ed6\u6587\u6863');
  }

  function pasteSel() {
    if (!state.clip) { setStatus('\u526a\u8d34\u677f\u4e3a\u7a7a'); return; }
    var dest = activeDoc();
    if (!dest) return;
    var clip = state.clip;
    PDFLib.PDFDocument.load(dest.bytes, { ignoreEncryption: true }).then(function (dpdf) {
      return PDFLib.PDFDocument.load(clip.bytes, { ignoreEncryption: true }).then(function (spdf) {
        var chain = Promise.resolve();
        clip.pages.forEach(function (p) {
          chain = chain.then(function () { return dpdf.copyPages(spdf, [p - 1]); })
            .then(function (arr) { dpdf.addPage(arr[0]); });
        });
        return chain.then(function () { return dpdf.save(); });
      });
    }).then(function (nb) {
      return ingest(dest.id, nb);
    }).then(function () {
      if (clip.cut && clip.srcId && clip.srcId !== dest.id) {
        var s = state.docs[clip.srcId];
        if (s) { s.pageOrder = s.pageOrder.filter(function (x) { return clip.pages.indexOf(x) === -1; }); s.dirty = true; }
      }
      state.clip = null;
      renderTabs();
      refreshAll();
      if (state.orgOpen) buildOrg(state.current);
      setStatus('\u5df2\u7c98\u8d34 ' + clip.pages.length + ' \u9875');
    }).catch(function (e) { setStatus('\u7c98\u8d34\u5931\u8d25: ' + e.message); console.error(e); });
  }

  function delSel() {
    var d = activeDoc();
    if (!d || !state.orgOpen || !state.orgSel.size) return;
    if (!confirm('\u786e\u8ba4\u5220\u9664\u6240\u9009 ' + state.orgSel.size + ' \u9875?')) return;
    if (d.pageOrder.length <= state.orgSel.size) { setStatus('\u81f3\u5c11\u8981\u4fdd\u7559\u4e00\u9875'); return; }
    state.orgSel.forEach(function (p) { var i = d.pageOrder.indexOf(p); if (i >= 0) d.pageOrder.splice(i, 1); });
    state.orgSel = new Set();
    d.dirty = true;
    if (state.orgOpen) buildOrg(state.current);
    updOrgInfo();
  }

  function openOrg() {
    var d = activeDoc();
    if (!d) return;
    state.orgOpen = true;
    state.orgSel = new Set();
    ov.classList.remove('hidden');
    renderOrgTargets();
    selectOrgDoc(state.current);
  }
  function closeOrg() {
    state.orgOpen = false;
    ov.classList.add('hidden');
  }
  /* \u4e0d\u4fdd\u5b58\u9000\u51fa */
  function exitOrg() {
    state.orgOpen = false;
    ov.classList.add('hidden');
    setStatus('\u5df2\u9000\u51fa\uff0c\u672a\u4fdd\u5b58');
  }

  /* \u7ec4\u7ec7\u9875\u9762\u9876\u90e8\u7684\u76ee\u6807\u680f\uff1a\u5c06\u9875\u9762\u62d6\u62fd\u5230\u5176\u4ed6\u6587\u6863\u4e0a\u5219\u5408\u5e76 */
  function renderOrgTargets() {
    var bar = document.getElementById('orgTargets');
    if (!bar) return;
    var activeId = state.current;
    bar.innerHTML = '';
    state.order.forEach(function (id) {
      var doc = state.docs[id];
      if (!doc) return;
      var t = document.createElement('div');
      t.className = 'org-target' + (id === activeId ? ' active' : '');
      t.dataset.id = id;
      var nm = document.createElement('span');
      nm.className = 'org-target-name';
      nm.textContent = doc.name + ' (' + doc.pageOrder.length + ')';
      t.appendChild(nm);
      t.addEventListener('dragover', function (e) { e.preventDefault(); this.classList.add('drag-over'); });
      t.addEventListener('dragleave', function () { this.classList.remove('drag-over'); });
      t.addEventListener('drop', function (e) { e.preventDefault(); this.classList.remove('drag-over'); mergeDocsTo(id, e); });
      t.addEventListener('click', function () { selectOrgDoc(id); });
      bar.appendChild(t);
    });
    var add = document.createElement('div');
    add.className = 'org-target org-target-new';
    add.textContent = '+ \u6253\u5f00\u65b0\u6587\u6863';
    add.addEventListener('click', function () { fileInput.focus(); fileInput.click(); });
    bar.appendChild(add);
  }
  function selectOrgDoc(id) {
    if (!state.docs[id]) return;
    state.current = id;
    state.currentPage = Math.min(state.currentPage || 1, state.docs[id].pageOrder.length || 1);
    renderOrgTargets();
    buildOrg(id);
    updOrgInfo();
  }
  /* \u8de8\u6587\u4ef6\u62d6\u62fd\u5408\u5e76\uff1a\u628a\u62d6\u62fd\u7684\u9875\u9762\u52a0\u5165\u76ee\u6807\u6587\u6863 */
  function mergeDocsTo(targetId, e) {
    var srcId = state.current;
    if (!state.docs[targetId]) return;
    var data = null;
    try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (err) { return; }
    if (!data || !data.picks || !data.picks.length) return;
    var src = state.docs[srcId];
    var tgt = state.docs[targetId];
    if (!src || !tgt) return;
    if (srcId === targetId) return;
    var picks = data.picks.slice();
    var done = function () {
      src.pageOrder = src.pageOrder.filter(function (x) { return picks.indexOf(x) === -1; });
      src.dirty = true; tgt.dirty = true;
      renderOrgTargets();
      // refresh previews
      if (state.orgOpen) { buildOrg(state.current); }
      setStatus('\u5df2\u5c06 ' + picks.length + ' \u9875\u5408\u5e76\u5230 ' + tgt.name);
    };
    // \u6570\u636e\u5f0f\u5408\u5e76\uff1a\u901a\u8fc7 PDFLib \u5c06\u6e90\u9875\u9762\u9644\u52a0\u5230\u76ee\u6807\u6587\u6863
    PDFLib.PDFDocument.load(tgt.bytes, { ignoreEncryption: true }).then(function (td) {
      return PDFLib.PDFDocument.load(src.bytes, { ignoreEncryption: true }).then(function (sd) {
        var chain = Promise.resolve();
        picks.forEach(function (p) {
          chain = chain.then(function () { return td.copyPages(sd, [p - 1]); })
            .then(function (arr) { td.addPage(arr[0]); });
        });
        return chain.then(function () { return td.save(); });
      });
    }).then(function (nb) {
      return ingest(targetId, nb).then(function () {
        // \u540e\u7eed\u4fdd\u6301\u9875\u9762\u987a\u5e8f\u517c\u5bb9\uff1a\u65b0\u589e\u9875\u9762 append
        done();
      });
    }).catch(function (err) { setStatus('\u5408\u5e76\u5931\u8d25: ' + err.message); console.error(err); });
  }

  function buildOrg(id) {
    orgGrid.innerHTML = '';
    var d = state.docs[id];
    if (!d || !d.pageOrder.length) { orgGrid.innerHTML = '<div class="org-empty">\u6b64\u6587\u6863\u6ca1\u6709\u9875\u9762</div>'; return; }
    var frag = document.createDocumentFragment();
    d.pageOrder.forEach(function (p) {
      var card = document.createElement('div');
      card.className = 'org-card' + (state.orgSel.has(p) ? ' selected' : '');
      card.dataset.phys = String(p);
      card.setAttribute('draggable', 'true');
      var n = document.createElement('div');
      n.className = 'org-num';
      n.textContent = '#' + p;
      var cv = document.createElement('canvas');
      card.appendChild(n);
      card.appendChild(cv);
      frag.appendChild(card);
      try {
        d.pdf.getPage(p).then(function (pg) {
          var v = pg.getViewport({ scale: 1 });
          var s = 150 / v.width;
          var v2 = pg.getViewport({ scale: s });
          var dr = window.deviceRatio || 1;
          cv.width = Math.floor(v2.width * dr);
          cv.height = Math.floor(v2.height * dr);
          cv.style.width = v2.width + 'px';
          pg.render({ canvasContext: cv.getContext('2d'), viewport: v2, transform: dr !== 1 ? [dr, 0, 0, dr, 0, 0] : null }).promise.catch(function () {});
        });
      } catch (e) {}
      card.addEventListener('click', function (e) {
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          if (state.orgSel.has(p)) state.orgSel.delete(p); else state.orgSel.add(p);
        } else {
          state.orgSel = new Set([p]);
        }
        buildOrg(id);
        updOrgInfo();
      });
      card.addEventListener('dragstart', function (e) {
        this.classList.add('dragging');
        var picks = state.orgSel.has(p) ? Array.from(state.orgSel) : [p];
        try { e.dataTransfer.setData('text/plain', JSON.stringify({ picks: picks })); } catch (err) {}
      });
      card.addEventListener('dragend', function () {
        this.classList.remove('dragging');
        orgGrid.querySelectorAll('.org-card').forEach(function (c) { c.classList.remove('drag-over'); });
      });
      card.addEventListener('dragover', function (e) {
        e.preventDefault();
        orgGrid.querySelectorAll('.org-card').forEach(function (c) { c.classList.remove('drag-over'); });
        this.classList.add('drag-over');
      });
      card.addEventListener('dragleave', function () { this.classList.remove('drag-over'); });
      card.addEventListener('drop', function (e) {
        e.preventDefault();
        this.classList.remove('drag-over');
        try {
          var data = JSON.parse(e.dataTransfer.getData('text/plain'));
          var picks = data.picks;
          var target = parseInt(this.dataset.phys, 10);
          var rem = d.pageOrder.filter(function (x) { return picks.indexOf(x) === -1; });
          var t = rem.indexOf(target);
          var idx = t < 0 ? rem.length : t;
          d.pageOrder = rem.slice(0, idx).concat(picks).concat(rem.slice(idx));
          d.dirty = true;
          buildOrg(id);
        } catch (err) {}
      });
    });
    orgGrid.appendChild(frag);
  }

  function updOrgInfo() {
    orgHint.textContent = state.orgSel.size
      ? ('\u5df2\u9009 ' + state.orgSel.size + ' \u9875 | Ctrl/Shift \u591a\u9009 | \u62d6\u52a8\u6392\u5e8f | \u53ef\u590d\u5236/\u526a\u5207/\u5220\u9664')
      : '\u70b9\u51fb\u9009\u9875 | Ctrl/Shift \u591a\u9009 | \u62d6\u52a8\u6392\u5e8f | \u590d\u5236/\u526a\u5207\u5230\u5176\u4ed6\u6587\u6863\u540e\u7c98\u8d34';
  }

  function renderTabs() {
    tabBar.innerHTML = '';
    var frag = document.createDocumentFragment();
    state.order.forEach(function (id) {
      var d = state.docs[id];
      var t = document.createElement('div');
      t.className = 'tab' + (id === state.current ? ' active' : '');
      t.dataset.id = id;
      var nm = document.createElement('span');
      nm.textContent = d.name + (d.dirty ? ' *' : '');
      var x = document.createElement('span');
      x.className = 'tab-close';
      x.textContent = 'x';
      t.appendChild(nm);
      t.appendChild(x);
      frag.appendChild(t);
      t.addEventListener('click', function () { switchTo(id); });
      x.addEventListener('click', function (e) { e.stopPropagation(); closeDoc(id); });
    });
    var add = document.createElement('div');
    add.className = 'tab-new';
    add.textContent = '+';
    add.title = '\u6253\u5f00\u65b0\u6587\u6863';
    add.addEventListener('click', function () { fileInput.click(); });
    frag.appendChild(add);
    tabBar.appendChild(frag);
  }

  function switchTo(id) {
    if (!state.docs[id]) return;
    state.current = id;
    state.currentPage = Math.min(state.currentPage, state.docs[id].pageOrder.length || 1);
    renderTabs();
    refreshAll();
    setStatus('\u5f53\u524d: ' + state.docs[id].name + ' (' + state.docs[id].pageOrder.length + ' \u9875)');
  }

  function closeDoc(id) {
    if (state.order.length <= 1) { setStatus('\u81f3\u5c11\u8981\u4fdd\u7559\u4e00\u4e2a\u6587\u6863'); return; }
    delete state.docs[id];
    state.order = state.order.filter(function (x) { return x !== id; });
    if (state.current === id) state.current = state.order[0];
    renderTabs();
    refreshAll();
  }

  $id('btnOpen').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function (e) {
    openFiles(e.target.files).then(function () { fileInput.value = ''; });
  });
  $id('btnOrganize').addEventListener('click', openOrg);
  $id('orgClose').addEventListener('click', function () { closeOrg(); refreshAll(); });
  $id('orgSelectAll').addEventListener('click', function () {
    var d = activeDoc();
    if (d) d.pageOrder.forEach(function (p) { state.orgSel.add(p); });
    buildOrg(state.current);
    updOrgInfo();
  });
  $id('orgClearSel').addEventListener('click', function () {
    state.orgSel = new Set();
    buildOrg(state.current);
    updOrgInfo();
  });
  $id('orgCopy').addEventListener('click', copySel);
  $id('orgCut').addEventListener('click', cutSel);
  $id('orgDelete').addEventListener('click', delSel);
  $id('orgPasteEnd').addEventListener('click', pasteSel);
  $id('btnExport').addEventListener('click', function () {
    var d = activeDoc();
    if (!d) return;
    setStatus('\u5bfc\u51fa\u4e2d...');
    PDFLib.PDFDocument.load(d.bytes, { ignoreEncryption: true })
      .then(function (src) { return PDFLib.PDFDocument.create().then(function (out) {
        var chain = Promise.resolve();
        d.pageOrder.forEach(function (p) {
          chain = chain.then(function () { return out.copyPages(src, [p - 1]); })
            .then(function (arr) { out.addPage(arr[0]); });
        });
        return chain.then(function () { return out.save(); });
      }); })
      .then(function (bytes) {
      var name = (d.name || 'document').replace(/\.pdf$/i, '');
      var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      var a = document.createElement('a');
      a.href = url;
      a.download = name + '_edited.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      setStatus('\u5df2\u5bfc\u51fa ' + a.download);
      d.dirty = false;
    }).catch(function (e) { setStatus('\u5bfc\u51fa\u5931\u8d25: ' + e.message); console.error(e); });
  });
  $id('btnSave').addEventListener('click', saveActive);
  $id('btnSaveAs').addEventListener('click', saveActiveAs);
  $id('orgExit').addEventListener('click', function () { exitOrg(); });

  // Ctrl+S \u4fdd\u5b58
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      saveActive();
    }
  });
  $id('btnPrev').addEventListener('click', prevPage);
  $id('btnNext').addEventListener('click', nextPage);
  $id('btnZoomIn').addEventListener('click', function () { setZoom(state.scale * 1.2); });
  $id('btnZoomOut').addEventListener('click', function () { setZoom(state.scale / 1.2); });
  $id('btnZoomFit').addEventListener('click', function () { setZoom(state.scale); });
  jump.addEventListener('change', function () {
    var v = parseInt(jump.value, 10);
    if (v >= 1) goToPage(v);
  });
  $id('btnThumbToggle').addEventListener('click', function () {
    setThumbPanel(!thumbPanel.classList.contains('collapsed'));
  });
  thumbCollapse.addEventListener('click', function () { setThumbPanel(true); });
  window.addEventListener('resize', function () { calcFit(); });

  /* \u4fdd\u5b58\u5f53\u524d\u6587\u6863 */
  function downloadBlob(bytes, fileName) {
    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    var a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function buildDocBytes(d, fileName) {
    return PDFLib.PDFDocument.load(d.bytes, { ignoreEncryption: true })
      .then(function (srcDoc) { return PDFLib.PDFDocument.create().then(function (out) {
        var chain = Promise.resolve();
        d.pageOrder.forEach(function (p) {
          chain = chain.then(function () { return out.copyPages(srcDoc, [p - 1]); })
            .then(function (arr) { out.addPage(arr[0]); });
        });
        return chain.then(function () { return out.save(); });
      }); });
  }
  function saveActive() {
    var d = activeDoc();
    if (!d) return;
    setStatus('\u6b63\u5728\u4fdd\u5b58...');
    buildDocBytes(d, d.name).then(function (bytes) {
      downloadBlob(bytes, d.name.replace(/\.pdf$/i, '') + '.pdf');
      d.dirty = false;
      renderTabs();
      setStatus('\u5df2\u4fdd\u5b58: ' + d.name);
    }).catch(function (e) { setStatus('\u4fdd\u5b58\u5931\u8d25: ' + e.message); console.error(e); });
  }
  function saveActiveAs() {
    var d = activeDoc();
    if (!d) return;
    var nm = (d.name || 'document').replace(/\.pdf$/i, '');
    var out = window.prompt('\u53e6\u5b58\u4e3a\uff08\u8f93\u5165\u6587\u4ef6\u540d\uff09:', nm + '_\u526f\u672c');
    if (out === null || out === '') return;
    out = out.replace(/\.pdf$/i, '') + '.pdf';
    setStatus('\u6b63\u5728\u53e6\u5b58\u4e3a...');
    buildDocBytes(d, out).then(function (bytes) {
      downloadBlob(bytes, out);
      setStatus('\u5df2\u53e6\u5b58\u4e3a: ' + out);
    }).catch(function (e) { setStatus('\u53e6\u5b58\u5931\u8d25: ' + e.message); console.error(e); });
  }
  function saveCurrentForExit() {
    var d = activeDoc();
    if (!d) return;
    return buildDocBytes(d, d.name).then(function (bytes) {
      // \u5c06\u4fdd\u5b58\u540e\u7684\u5b57\u8282\u91cd\u65b0\u5f15\u5165
      return ingest(d.id, bytes).then(function () {
        d.dirty = false; return d;
      });
    });
  }
  function loadByName(name) {
    return loadUrl(name, '/api/pdf/' + encodeURIComponent(name)).then(function (id) {
      state.current = id;
      state.currentPage = 1;
      renderTabs();
      refreshAll();
      setStatus('\u5f53\u524d: ' + name);
    });
  }
  function loadUrl(name, url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      var id = addDoc(name);
      return ingest(id, new Uint8Array(buf));
    });
  }

    fetch('/api/pdfs').then(function (r) { return r.json(); }).then(function (files) {
    if (files && files.length) loadByName(files[0].name);
  }).catch(function () {});

  window.pdfTool = { openFiles: openFiles, loadByName: loadByName };
})();
