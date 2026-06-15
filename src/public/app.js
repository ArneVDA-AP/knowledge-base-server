// State
let currentSection = 'upload';
let currentDocId = null;

// Init
document.addEventListener('DOMContentLoaded', async () => {
  const res = await fetch('/api/session/check');
  const data = await res.json();
  if (data.authenticated) {
    showApp();
  } else {
    showLogin();
  }
});

// Auth
function showLogin() {
  document.getElementById('login-screen').hidden = false;
  document.getElementById('app').hidden = true;
}

function showApp() {
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app').hidden = false;
  loadStats();
}

// Login form
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('login-password').value;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/session/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      showApp();
    } else {
      const err = document.getElementById('login-error');
      err.textContent = 'Invalid password';
      err.hidden = false;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

document.getElementById('toggle-password').addEventListener('click', () => {
  const input = document.getElementById('login-password');
  const btn = document.getElementById('toggle-password');
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type = 'password';
    btn.textContent = 'Show';
  }
});

// Navigation
document.querySelectorAll('[data-section]').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const section = e.target.dataset.section;
    showSection(section);
  });
});

function showSection(name) {
  currentSection = name;
  document.querySelectorAll('.section').forEach(s => s.hidden = true);
  document.getElementById(`section-${name}`).hidden = false;
  document.querySelectorAll('[data-section]').forEach(l => l.classList.toggle('active', l.dataset.section === name));
  if (name === 'documents') loadDocuments();
  if (name === 'settings') loadStats();
  if (name === 'memory') { loadMemoryQueue(); recallMemoryAction(); }
}

// Logout
document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/session/logout', { method: 'POST' });
  showLogin();
});

// --- Upload ---
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  uploadFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => uploadFiles(fileInput.files));

async function uploadFiles(files) {
  const formData = new FormData();
  for (const file of files) formData.append('files', file);
  const tags = document.getElementById('upload-tags').value;
  if (tags) formData.append('tags', tags);

  try {
    const res = await fetch('/api/documents', { method: 'POST', body: formData });
    const data = await res.json();
    const results = document.getElementById('upload-results');
    results.hidden = false;
    // Build results using DOM methods for safety
    results.textContent = '';
    const successP = document.createElement('p');
    successP.className = 'success';
    successP.textContent = 'Uploaded ' + data.documents.length + ' file(s):';
    results.appendChild(successP);
    data.documents.forEach(d => {
      const p = document.createElement('p');
      p.textContent = '- ' + d.title + ' (' + d.doc_type + ')';
      results.appendChild(p);
    });
    showToast(data.documents.length + ' file(s) uploaded', 'success');
  } catch (err) {
    showToast('Upload failed: ' + err.message, 'error');
  }
}

// Bulk ingest
document.getElementById('ingest-btn').addEventListener('click', async () => {
  const path = document.getElementById('ingest-path').value;
  if (!path) return;
  try {
    const res = await fetch('/api/ingest-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    const results = document.getElementById('ingest-results');
    results.hidden = false;
    results.textContent = '';
    const successP = document.createElement('p');
    successP.className = 'success';
    successP.textContent = 'Ingested: ' + data.ingested + ', Skipped: ' + data.skipped;
    results.appendChild(successP);
    if (data.errors && data.errors.length) {
      data.errors.forEach(e => {
        const p = document.createElement('p');
        p.className = 'error';
        p.textContent = e;
        results.appendChild(p);
      });
    }
    showToast('Ingested ' + data.ingested + ' files', 'success');
  } catch (err) {
    showToast('Ingest failed: ' + err.message, 'error');
  }
});

// --- Documents ---
let searchTimeout;
document.getElementById('search-input').addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(loadDocuments, 300);
});
document.getElementById('type-filter').addEventListener('change', loadDocuments);

async function loadDocuments() {
  const q = document.getElementById('search-input').value;
  const type = document.getElementById('type-filter').value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (type) params.set('type', type);
  params.set('limit', '100');

  const res = await fetch('/api/documents?' + params);
  const docs = await res.json();
  renderDocumentList(docs);
}

function renderDocumentList(docs) {
  const container = document.getElementById('doc-list');
  container.textContent = '';

  if (!docs.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No documents found';
    container.appendChild(p);
    return;
  }

  const isSearch = !!document.getElementById('search-input').value;

  const table = document.createElement('table');
  table.className = 'doc-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  ['Title', 'Type', 'Tags', 'Size', 'Date'].forEach(text => {
    const th = document.createElement('th');
    th.textContent = text;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  docs.forEach(d => {
    const tr = document.createElement('tr');
    tr.dataset.id = d.id;
    tr.style.cursor = 'pointer';

    // Title cell - may contain FTS snippet HTML with <mark> tags
    const tdTitle = document.createElement('td');
    if (isSearch && d.snippet) {
      // Sanitize: escape all HTML, then restore only <mark> and </mark>
      const escaped = d.snippet
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      tdTitle.innerHTML = escaped
        .replace(/&lt;mark&gt;/g, '<mark>')
        .replace(/&lt;\/mark&gt;/g, '</mark>');
    } else {
      tdTitle.textContent = d.title;
    }
    tr.appendChild(tdTitle);

    // Type cell
    const tdType = document.createElement('td');
    const typePill = document.createElement('span');
    typePill.className = 'tag-pill';
    typePill.textContent = d.doc_type;
    tdType.appendChild(typePill);
    tr.appendChild(tdType);

    // Tags cell
    const tdTags = document.createElement('td');
    (d.tags || '').split(',').filter(Boolean).forEach(t => {
      const span = document.createElement('span');
      span.className = 'tag-pill';
      span.textContent = t.trim();
      tdTags.appendChild(span);
    });
    tr.appendChild(tdTags);

    // Size cell
    const tdSize = document.createElement('td');
    tdSize.textContent = formatSize(d.file_size || 0);
    tr.appendChild(tdSize);

    // Date cell
    const tdDate = document.createElement('td');
    tdDate.textContent = new Date(d.created_at).toLocaleDateString();
    tr.appendChild(tdDate);

    tr.addEventListener('click', () => viewDocument(parseInt(tr.dataset.id)));
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.appendChild(table);
}

async function viewDocument(id) {
  const res = await fetch('/api/documents/' + id);
  if (!res.ok) return;
  const doc = await res.json();
  currentDocId = id;

  document.getElementById('modal-title').textContent = doc.title;
  document.getElementById('modal-type').textContent = doc.doc_type;
  document.getElementById('modal-date').textContent = new Date(doc.created_at).toLocaleDateString();
  document.getElementById('modal-size').textContent = formatSize(doc.file_size || 0);
  document.getElementById('modal-tags-input').value = doc.tags || '';
  document.getElementById('modal-content').textContent = doc.content;
  document.getElementById('doc-modal').hidden = false;
}

// Modal controls
document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('doc-modal').hidden = true;
});
document.getElementById('doc-modal').addEventListener('click', (e) => {
  if (e.target.id === 'doc-modal') document.getElementById('doc-modal').hidden = true;
});

document.getElementById('modal-save-tags').addEventListener('click', async () => {
  const tags = document.getElementById('modal-tags-input').value;
  await fetch('/api/documents/' + currentDocId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: tags }),
  });
  showToast('Tags updated', 'success');
});

document.getElementById('modal-delete').addEventListener('click', async () => {
  if (!confirm('Delete this document?')) return;
  await fetch('/api/documents/' + currentDocId, { method: 'DELETE' });
  document.getElementById('doc-modal').hidden = true;
  showToast('Document deleted', 'success');
  loadDocuments();
});

// --- Settings ---
async function loadStats() {
  const res = await fetch('/api/stats');
  const stats = await res.json();
  const display = document.getElementById('stats-display');
  display.textContent = '';

  var items = [
    { label: 'Documents: ', value: stats.count },
    { label: 'Total Size: ', value: formatSize(stats.totalSize || 0) },
    { label: 'Database Size: ', value: formatSize(stats.dbFileSize || 0) }
  ];

  items.forEach(function(item) {
    var p = document.createElement('p');
    p.textContent = item.label;
    var strong = document.createElement('strong');
    strong.textContent = item.value;
    p.appendChild(strong);
    display.appendChild(p);
  });
}

document.getElementById('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const current = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;
  const res = await fetch('/api/session/password', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: current, newPassword: newPassword }),
  });
  if (res.ok) {
    showToast('Password updated', 'success');
    document.getElementById('current-password').value = '';
    document.getElementById('new-password').value = '';
  } else {
    showToast('Failed to update password', 'error');
  }
});

// --- Memory (two-way bridge) ---
function memBadge(text, cls) {
  const s = document.createElement('span');
  s.className = 'tag-pill' + (cls ? ' ' + cls : '');
  s.textContent = text;
  return s;
}

function buildMemoryCard(m, opts) {
  opts = opts || {};
  const card = document.createElement('div');
  card.className = 'memory-card';

  const head = document.createElement('div');
  head.className = 'memory-card-head';
  // Memories have no title — the content IS the memory. Label the card by its kind.
  const title = document.createElement('strong');
  title.textContent = m.kind || 'memory';
  head.appendChild(title);

  const badges = document.createElement('div');
  badges.className = 'memory-badges';
  badges.appendChild(memBadge(m.created_by || 'system', 'prov-' + (m.created_by || 'system')));
  if (m.confidence) badges.appendChild(memBadge(m.confidence));
  if (m.review_status && m.review_status !== 'none') badges.appendChild(memBadge(m.review_status, m.review_status === 'rejected' ? 'error' : ''));
  if (typeof m.salience === 'number') badges.appendChild(memBadge('sal ' + m.salience));
  if (m.superseded_by) badges.appendChild(memBadge('superseded', 'error'));
  head.appendChild(badges);
  card.appendChild(head);

  const content = document.createElement('p');
  content.className = 'memory-content';
  content.textContent = m.content || '';
  card.appendChild(content);

  if (m.reasoning) {
    const r = document.createElement('p');
    r.className = 'memory-reasoning';
    r.textContent = 'Why: ' + m.reasoning;
    card.appendChild(r);
  }

  const actions = document.createElement('div');
  actions.className = 'memory-actions';
  if (opts.review) {
    const accept = document.createElement('button');
    accept.className = 'btn-sm';
    accept.textContent = 'Accept';
    accept.addEventListener('click', () => reviewMemoryAction(m.id, 'accept'));
    const reject = document.createElement('button');
    reject.className = 'btn-sm btn-danger';
    reject.textContent = 'Reject';
    reject.addEventListener('click', () => reviewMemoryAction(m.id, 'reject'));
    actions.appendChild(accept);
    actions.appendChild(reject);
  }
  if (opts.outcome) {
    const helped = document.createElement('button');
    helped.className = 'btn-sm';
    helped.textContent = 'Helped';
    helped.addEventListener('click', () => outcomeMemoryAction(m.id, 'helped'));
    const burned = document.createElement('button');
    burned.className = 'btn-sm btn-danger';
    burned.textContent = 'Burned';
    burned.addEventListener('click', () => outcomeMemoryAction(m.id, 'burned'));
    actions.appendChild(helped);
    actions.appendChild(burned);
  }
  card.appendChild(actions);
  return card;
}

async function loadMemoryQueue() {
  const res = await fetch('/api/memory/pending');
  const data = await res.json();
  const container = document.getElementById('memory-queue');
  container.textContent = '';
  const items = (data && data.pending) || [];
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Nothing to review — the queue is clear.';
    container.appendChild(p);
    return;
  }
  items.forEach(m => container.appendChild(buildMemoryCard(m, { review: true })));
}

async function reviewMemoryAction(id, action) {
  await fetch('/api/memory/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id, action: action }),
  });
  showToast('Memory ' + action + (action === 'reject' ? 'ed' : 'ed'), action === 'reject' ? 'error' : 'success');
  loadMemoryQueue();
}

async function outcomeMemoryAction(id, outcome) {
  await fetch('/api/memory/' + id + '/outcome', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcome: outcome }),
  });
  showToast('Recorded: ' + outcome, outcome === 'burned' ? 'error' : 'success');
  recallMemoryAction();
  loadMemoryQueue();
}

async function recallMemoryAction() {
  const q = document.getElementById('memory-recall-input').value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  params.set('limit', '15');
  const res = await fetch('/api/memory/recall?' + params);
  const data = await res.json();
  const container = document.getElementById('memory-recall-results');
  container.textContent = '';
  const items = (data && data.results) || [];
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = q ? 'No memories recalled for that query.' : 'No memories yet.';
    container.appendChild(p);
    return;
  }
  items.forEach(m => container.appendChild(buildMemoryCard(m, { outcome: true })));
}

document.getElementById('memory-recall-btn').addEventListener('click', recallMemoryAction);
document.getElementById('memory-recall-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') recallMemoryAction();
});

// --- Helpers ---
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function showToast(message, type) {
  type = type || 'success';
  var toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast ' + type;
  toast.hidden = false;
  setTimeout(function() { toast.hidden = true; }, 3000);
}
