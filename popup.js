/* ─── Shared DOM refs ─── */
const statusText = document.getElementById('status');
const logBox     = document.getElementById('log');
const barFill    = document.getElementById('barFill');

/* ─── Tab switching ─── */
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`panel-${btn.dataset.tab}`).classList.remove('hidden');
    resetProgress();
  });
});

/* ─── Utilities ─── */
function log(msg) {
  logBox.textContent += `${msg}\n`;
  logBox.scrollTop = logBox.scrollHeight;
}

function resetProgress() {
  logBox.textContent = '';
  barFill.style.width = '0%';
  statusText.textContent = 'Ready.';
}

function setProgress(done, total, label) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  barFill.style.width = `${pct}%`;
  statusText.textContent = label || `${done}/${total}`;
}

function parseUrls(raw) {
  return [...new Set(
    raw.split(/[\n,\s]+/)
      .map(v => v.trim())
      .filter(Boolean)
      .map(v => /^https?:\/\//i.test(v) ? v : `https://${v}`)
  )];
}

function safeFileName(url, fallback = 'file') {
  return (url || fallback)
    .replace(/^https?:\/\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .slice(0, 120) || fallback;
}

function dateStamp() {
  const n = new Date(), p = v => String(v).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())}_${p(n.getHours())}-${p(n.getMinutes())}-${p(n.getSeconds())}`;
}

async function fetchText(url) {
  const res = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Fetch the page HTML, inline all linked CSS files as <style> tags,
 * and return a single self-contained HTML string.
 */
async function buildCombinedHtml(pageUrl, sameOriginOnly) {
  const rawHtml = await fetchText(pageUrl);
  const base    = new URL(pageUrl);

  // Parse into a live DOM so we can manipulate it
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');

  // Set <base> so relative paths still resolve if opened locally
  let baseEl = doc.querySelector('base');
  if (!baseEl) {
    baseEl = doc.createElement('base');
    doc.head.prepend(baseEl);
  }
  baseEl.setAttribute('href', pageUrl);

  // Find all <link rel="stylesheet"> elements
  const linkEls = [...doc.querySelectorAll('link[rel~="stylesheet"][href]')];
  let cssCount = 0;

  for (const link of linkEls) {
    let cssUrl;
    try { cssUrl = new URL(link.getAttribute('href'), pageUrl).href; } catch { continue; }

    // Respect same-origin filter
    if (sameOriginOnly && new URL(cssUrl).origin !== base.origin) continue;

    try {
      const cssText = await fetchText(cssUrl);
      const style   = doc.createElement('style');
      style.setAttribute('data-source', cssUrl);
      style.textContent = cssText;
      link.replaceWith(style);
      cssCount++;
      log(`  CSS inlined: ${cssUrl}`);
    } catch (e) {
      log(`  CSS failed (kept as link): ${cssUrl} — ${e.message}`);
      // Leave the <link> in place so the file records the failure gracefully
    }
  }

  log(`  ${cssCount} CSS file(s) inlined.`);

  // Serialise back to a string
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

/** Extract all same-origin <a href> links from parsed HTML */
function extractLinks(html, pageUrl) {
  const doc    = new DOMParser().parseFromString(html, 'text/html');
  const origin = new URL(pageUrl).origin;
  const links  = new Set();
  for (const a of doc.querySelectorAll('a[href]')) {
    try {
      const resolved = new URL(a.getAttribute('href'), pageUrl);
      if (resolved.origin === origin) {
        resolved.hash = '';
        const href = resolved.href.replace(/\/$/, '');
        if (href) links.add(href);
      }
    } catch { /* skip */ }
  }
  return [...links];
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
}

function setButtons(disabled) {
  extractBtn.disabled    = disabled;
  clearBtn.disabled      = disabled;
  crawlBtn.disabled      = disabled;
  crawlClearBtn.disabled = disabled;
}

/* ─────────────────────────────────────────────
   BULK URLs MODE
   ZIP structure:
     001_pagename.html   ← combined HTML + CSS
     002_pagename.html
     summary.json
   ───────────────────────────────────────────── */
const extractBtn = document.getElementById('extractBtn');
const clearBtn   = document.getElementById('clearBtn');
const urlsInput  = document.getElementById('urls');

clearBtn.addEventListener('click', () => { urlsInput.value = ''; resetProgress(); });

extractBtn.addEventListener('click', async () => {
  const urls           = parseUrls(urlsInput.value);
  const sameOriginOnly = document.getElementById('sameOriginCss').checked;

  resetProgress();
  if (!urls.length) { statusText.textContent = 'Enter at least one URL.'; return; }

  setButtons(true);
  const zip     = new SimpleZip();
  const summary = { created_at: new Date().toISOString(), mode: 'bulk', pages: [] };
  let done = 0;

  for (let i = 0; i < urls.length; i++) {
    const pageUrl  = urls[i];
    const pageName = `${String(i + 1).padStart(3, '0')}_${safeFileName(pageUrl)}`;
    const pageInfo = { url: pageUrl, file: '', status: 'pending', error: '' };

    setProgress(done, urls.length, `Fetching ${i + 1}/${urls.length}: ${pageUrl}`);
    log(`[${i + 1}/${urls.length}] ${pageUrl}`);

    try {
      const combined = await buildCombinedHtml(pageUrl, sameOriginOnly);
      const filePath = `${pageName}.html`;
      zip.addFile(filePath, combined);
      pageInfo.file   = filePath;
      pageInfo.status = 'success';
    } catch (e) {
      pageInfo.status = 'failed';
      pageInfo.error  = e.message;
      zip.addFile(`${pageName}_ERROR.txt`, `URL: ${pageUrl}\nError: ${e.message}`);
      log(`  FAILED: ${e.message}`);
    }

    summary.pages.push(pageInfo);
    done++;
    setProgress(done, urls.length);
  }

  zip.addFile('summary.json', JSON.stringify(summary, null, 2));
  const filename = `bulk-source-${dateStamp()}.zip`;
  triggerDownload(zip.generateBlob(), filename);
  statusText.textContent = `Done — ${done} page(s) in ZIP.`;
  log(`ZIP ready: ${filename}`);
  setButtons(false);
});

/* ─────────────────────────────────────────────
   SITE CRAWL MODE
   BFS from one URL, same domain only.
   ZIP structure: same as Bulk (one .html per page)
   ───────────────────────────────────────────── */
const crawlBtn      = document.getElementById('crawlBtn');
const crawlClearBtn = document.getElementById('crawlClearBtn');
const crawlUrlInput = document.getElementById('crawlUrl');
const maxPagesInput = document.getElementById('maxPages');

crawlClearBtn.addEventListener('click', () => { crawlUrlInput.value = ''; resetProgress(); });

crawlBtn.addEventListener('click', async () => {
  const startUrl       = crawlUrlInput.value.trim();
  const maxPages       = Math.max(1, parseInt(maxPagesInput.value, 10) || 50);
  const sameOriginOnly = document.getElementById('crawlSameOriginCss').checked;

  resetProgress();
  if (!startUrl) { statusText.textContent = 'Enter a starting URL.'; return; }

  let startOrigin;
  try { startOrigin = new URL(startUrl).origin; }
  catch { statusText.textContent = 'Invalid URL.'; return; }

  setButtons(true);
  const zip     = new SimpleZip();
  const summary = { created_at: new Date().toISOString(), mode: 'crawl', start_url: startUrl, pages: [] };

  const visited = new Set();
  const queue   = [startUrl.replace(/\/$/, '')];
  visited.add(queue[0]);
  let pageIndex = 0;

  while (queue.length > 0 && pageIndex < maxPages) {
    const pageUrl  = queue.shift();
    const pageName = `${String(pageIndex + 1).padStart(3, '0')}_${safeFileName(pageUrl)}`;
    const pageInfo = { url: pageUrl, file: '', status: 'pending', error: '' };

    setProgress(pageIndex, maxPages, `Crawling page ${pageIndex + 1}: ${pageUrl}`);
    log(`[${pageIndex + 1}] ${pageUrl}`);

    try {
      // Fetch raw HTML first so we can discover links before inlining
      const rawHtml = await fetchText(pageUrl);

      // Discover and enqueue new links
      const links = extractLinks(rawHtml, pageUrl);
      let newFound = 0;
      for (const link of links) {
        if (!visited.has(link) && new URL(link).origin === startOrigin) {
          visited.add(link);
          queue.push(link);
          newFound++;
        }
      }
      log(`  → ${links.length} link(s), ${newFound} new`);

      // Now build the combined file
      const combined = await buildCombinedHtml(pageUrl, sameOriginOnly);
      const filePath = `${pageName}.html`;
      zip.addFile(filePath, combined);
      pageInfo.file   = filePath;
      pageInfo.status = 'success';
    } catch (e) {
      pageInfo.status = 'failed';
      pageInfo.error  = e.message;
      zip.addFile(`${pageName}_ERROR.txt`, `URL: ${pageUrl}\nError: ${e.message}`);
      log(`  FAILED: ${e.message}`);
    }

    summary.pages.push(pageInfo);
    pageIndex++;
  }

  if (queue.length > 0) {
    log(`Stopped at ${maxPages}-page limit. ${queue.length} more link(s) not fetched.`);
  }

  zip.addFile('summary.json', JSON.stringify(summary, null, 2));
  const filename = `site-crawl-${dateStamp()}.zip`;
  triggerDownload(zip.generateBlob(), filename);
  statusText.textContent = `Done — ${pageIndex} page(s) crawled.`;
  log(`ZIP ready: ${filename}`);
  setButtons(false);
});

/* ─── SimpleZip ─── */
class SimpleZip {
  constructor() { this.files = []; }

  addFile(name, content) {
    const normalized = name.replace(/^\/+/, '').replace(/\\/g, '/');
    if (this.files.some(f => f.name === normalized)) return; // no duplicates
    this.files.push({ name: normalized, data: new TextEncoder().encode(content) });
  }

  generateBlob() {
    const localParts = [], centralParts = [];
    let offset = 0;
    for (const file of this.files) {
      const nameBytes = new TextEncoder().encode(file.name);
      const crc  = crc32(file.data);
      const size = file.data.length;

      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, size, true); lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lh.set(nameBytes, 30);
      localParts.push(lh, file.data);

      const ch = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);
      centralParts.push(ch);
      offset += lh.length + file.data.length;
    }
    const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
    const eh = new Uint8Array(22);
    const ev = new DataView(eh.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.files.length, true); ev.setUint16(10, this.files.length, true);
    ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
    return new Blob([...localParts, ...centralParts, eh], { type: 'application/zip' });
  }
}

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
