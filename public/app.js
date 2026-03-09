// ========== DOM Elements ==========
const urlForm = document.getElementById('url-form');
const urlInput = document.getElementById('url-input');
const fetchBtn = document.getElementById('fetch-btn');
const btnText = fetchBtn.querySelector('.btn-text');
const btnLoader = fetchBtn.querySelector('.btn-loader');
const errorMsg = document.getElementById('error-msg');
const results = document.getElementById('results');
const videoTitle = document.getElementById('video-title');
const videoThumb = document.getElementById('video-thumb');
const videoDuration = document.getElementById('video-duration');
const videoUploader = document.getElementById('video-uploader');
const videoViews = document.getElementById('video-views');
const tabContent = document.getElementById('tab-content');

let currentData = null;
let activeTab = 'combined';

// ========== Form Submit ==========
urlForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;

    setLoading(true);
    hideError();
    results.hidden = true;

    try {
        const resp = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
        const data = await resp.json();

        if (!resp.ok) throw new Error(data.error || 'Something went wrong');

        currentData = data;
        renderVideoInfo(data);
        renderFormats(data[activeTab] || []);
        results.hidden = false;
        results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
        showError(err.message);
    } finally {
        setLoading(false);
    }
});

// ========== Tab Switching ==========
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeTab = btn.dataset.tab;
        if (currentData) {
            renderFormats(currentData[activeTab] || []);
        }
    });
});

// ========== Render Functions ==========
function renderVideoInfo(data) {
    videoTitle.textContent = data.title;
    videoThumb.src = data.thumbnail;
    videoThumb.alt = data.title;
    videoDuration.textContent = formatDuration(data.duration);
    videoUploader.textContent = data.uploader || 'Unknown';
    videoViews.textContent = data.viewCount ? formatViews(data.viewCount) + ' views' : '';
}

function renderFormats(formats) {
    if (!formats.length) {
        tabContent.innerHTML = '<div class="empty-state">No formats available in this category</div>';
        return;
    }

    // Sort by resolution (height) descending, then by bitrate
    const sorted = [...formats].sort((a, b) => {
        const hA = parseHeight(a.resolution);
        const hB = parseHeight(b.resolution);
        if (hB !== hA) return hB - hA;
        return (b.tbr || 0) - (a.tbr || 0);
    });

    const url = urlInput.value.trim();
    const videoTitleEncoded = encodeURIComponent(currentData ? currentData.title : 'download');

    tabContent.innerHTML = sorted.map(f => {
        const dlUrl = `/api/download?url=${encodeURIComponent(url)}&formatId=${encodeURIComponent(f.formatId)}&title=${videoTitleEncoded}&ext=${encodeURIComponent(f.ext)}`;
        return `
    <div class="format-row">
      <div class="format-info">
        <span class="format-res">${escapeHtml(f.resolution)}${f.fps && f.fps > 30 ? ` <small style="color:var(--orange)">${f.fps}fps</small>` : ''}</span>
        <span class="format-detail">${[f.vcodec, f.acodec].filter(Boolean).join(' + ')}</span>
      </div>
      <span class="format-ext">${escapeHtml(f.ext)}</span>
      <span class="format-size">${f.filesize ? formatSize(f.filesize) : '—'}</span>
      <a class="dl-btn" href="${dlUrl}" download title="Download">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download
      </a>
    </div>
  `}).join('');
}

// ========== Helpers ==========
function setLoading(loading) {
    fetchBtn.disabled = loading;
    btnText.hidden = loading;
    btnLoader.hidden = !loading;
}

function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.hidden = false;
}

function hideError() {
    errorMsg.hidden = true;
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

function formatDuration(dur) {
    if (typeof dur === 'string') return dur;
    if (typeof dur !== 'number') return '';
    const h = Math.floor(dur / 3600);
    const m = Math.floor((dur % 3600) / 60);
    const s = dur % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function formatViews(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toLocaleString();
}

function parseHeight(res) {
    if (!res) return 0;
    const m = res.match(/(\d+)x(\d+)/);
    if (m) return parseInt(m[2]);
    const p = res.match(/(\d+)p/);
    if (p) return parseInt(p[1]);
    return 0;
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
