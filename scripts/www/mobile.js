"use strict";
/**
 * mobile.js - 移动端逻辑
 * API 调用 + 搜索渲染 + 在线播放 + 原生下载
 */

// ============ API 层（fetch 直调落月 API，多源降级） ============

const OFFICIAL = 'https://api.vkeys.cn';
const SELF = 'http://xwl.vincentzyu233.cn:51217';
const METING_PROVIDERS = [
  (id) => `https://api.qijieya.cn/meting/?type=url&id=${id}`,
  (id) => `https://api.injahow.cn/meting/?type=url&id=${id}`,
];

/** gdstudio 备用接口（JSON 直链，无重定向；网易云可用） */
const GD_API = 'https://music-api.gdstudio.xyz/api.php';
/** QQ 音乐官方接口合法音质取值（其他值会被接口拒绝） */
const QQ_QUALITY_VALUES = [4, 8, 10, 11, 12, 14];

const PLATFORM_LABEL = { netease: '网易云', tencent: 'QQ音乐' };

// ============ 原生 HTTP（走 Android 原生网络栈，绕开 WebView CORS/opaqueredirect 限制） ============

function nativeHttp() {
  if (window.Capacitor) {
    if (window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
      return window.Capacitor.Plugins.CapacitorHttp;
    }
    if (window.Capacitor.registerPlugin) {
      return window.Capacitor.registerPlugin('CapacitorHttp');
    }
  }
  return null;
}

async function getJson(url, timeout = 20000) {
  const http = nativeHttp();
  if (http) {
    const res = await http.get({
      url,
      connectTimeout: timeout,
      readTimeout: timeout,
      responseType: 'json',
    });
    if (res.status >= 200 && res.status < 300) {
      let data = res.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_) { /* 保留字符串 */ }
      }
      return data;
    }
    throw new Error('HTTP ' + res.status);
  }
  // 浏览器环境降级（仅开发调试用）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSong(song, platform) {
  let duration = 0;
  if (song.interval) {
    const m = String(song.interval).match(/(\d+)分(\d+)秒/);
    if (m) duration = (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000;
    else if (!Number.isNaN(parseFloat(song.interval))) duration = parseFloat(song.interval) * 1000;
  }
  return {
    id: song.id, mid: song.mid,
    name: song.song || song.name || song.title || '未知歌曲',
    artist: song.singer || song.artist || '未知歌手',
    album: song.album || '',
    duration,
    cover: song.cover || song.pic || '',
    url: song.url || '',
    quality: song.quality || '',
    size: song.size || '',
    kbps: song.kbps || '',
    link: song.link || '',
    platform: platform || '',
  };
}

async function searchPlatform(baseUrl, platform, keyword, num, quality) {
  const url = `${baseUrl}/v2/music/${platform}?word=${encodeURIComponent(keyword)}&num=${num}&quality=${quality}`;
  const data = await getJson(url);
  if (!data || data.code !== 200 || !data.data) throw new Error((data && data.msg) || '搜索接口异常');
  const items = Array.isArray(data.data) ? data.data : [data.data];
  return items.map((s) => normalizeSong(s, platform));
}

async function searchWithFallback(platform, keyword, num, quality) {
  // 官方网易云搜索接口音质合法范围仅 1~2（3 及以上返回 500），自建 API 支持 1~9
  const safeQuality = platform === 'netease' ? Math.min(quality, 2) : quality;
  try {
    return await searchPlatform(OFFICIAL, platform, keyword, num, safeQuality);
  } catch (e) {
    try {
      return await searchPlatform(SELF, platform, keyword, num, quality);
    } catch (_) {
      throw new Error(e.message || '搜索失败');
    }
  }
}

async function search(keyword, platform, num, qualityNetease, qualityQQ) {
  if (platform === 'aggregation') {
    const [n, t] = await Promise.all([
      searchWithFallback('netease', keyword, num, qualityNetease).catch(() => []),
      searchWithFallback('tencent', keyword, num, qualityQQ).catch(() => []),
    ]);
    const merged = [];
    const max = Math.max(n.length, t.length);
    for (let i = 0; i < max; i++) {
      if (i < n.length) merged.push({ ...n[i], platform: 'netease' });
      if (i < t.length) merged.push({ ...t[i], platform: 'tencent' });
    }
    return merged;
  }
  const p = platform === 'netease' ? 'netease' : 'tencent';
  return searchWithFallback(p, keyword, num, p === 'netease' ? qualityNetease : qualityQQ);
}

/**
 * 解析 302 重定向后的真实直链（meting 系接口）
 * - Capacitor 原生 HTTP：正确参数名为 disableRedirects（否则原生会自动跟随重定向，拿不到 Location）
 * - 浏览器 / Electron：fetch(redirect:'manual') 只能拿到 opaqueredirect（status 0，读不到 Location），
 *   因此直接返回中转地址，由 <audio> 元素或系统下载器自动跟随 302
 * @returns {Promise<string|null>} 真实直链；原生环境解析失败返回 null，浏览器环境返回中转地址
 */
async function getRedirectUrl(url, timeout = 15000) {
  const http = nativeHttp();
  if (http) {
    let res;
    try {
      res = await http.get({
        url,
        disableRedirects: true,
        connectTimeout: timeout,
        readTimeout: timeout,
        responseType: 'text',
      });
    } catch (err) {
      throw new Error('请求失败：' + (err && err.message ? err.message : err));
    }
    const h = res.headers || {};
    const loc = h.Location || h.location || h['Location'] || h['location'];
    if (res.status >= 300 && res.status < 400 && loc) return new URL(loc, url).toString();
    // 少数镜像直接把直链以纯文本返回
    const body = typeof res.data === 'string' ? res.data.trim() : '';
    if (res.status === 200 && /^https?:\/\//i.test(body)) return body;
    // 部分镜像直接返回音频流（HTTP 200 + audio/*），此时中转地址本身即可播放
    const ctype = String(h['Content-Type'] || h['content-type'] || '');
    if (res.status < 400 && /audio|octet-stream|mpeg|mp3/i.test(ctype)) return url;
    return null;
  }
  // 浏览器 / Electron：读不到 Location，交给播放器跟随 302
  return url;
}

/**
 * 通过 meting 镜像解析网易云直链，返回候选列表
 * 原生环境得到 302 后的真实直链；浏览器环境得到中转地址（播放器会自动跟随 302）
 */
async function getMetingUrls(id) {
  const list = [];
  for (const build of METING_PROVIDERS) {
    const mid = build(id);
    try {
      const direct = await getRedirectUrl(mid);
      if (direct && !list.includes(direct)) list.push(direct);
    } catch (_) { /* 该镜像不可用，尝试下一个 */ }
  }
  return list;
}

async function getNeteaseFromSelf(id, quality) {
  const primary = Math.min(Math.max(parseInt(quality, 10) || 1, 1), 9);
  const tryList = primary === 1 ? [1] : [primary, 1];
  for (const q of tryList) {
    try {
      const data = await getJson(`${SELF}/v2/music/netease?id=${id}&quality=${q}`);
      if (data && data.code === 200 && data.data && data.data.url) return normalizeSong(data.data, 'netease');
    } catch (_) { /* 该音质不可用，降级重试 */ }
  }
  return null;
}

/** gdstudio 备用接口：直接返回 JSON 直链（无重定向） */
async function getGdStudioUrl(platform, id) {
  if (!id) return null;
  try {
    const data = await getJson(`${GD_API}?types=url&source=${platform}&id=${encodeURIComponent(id)}&br=320`);
    const url = data && typeof data.url === 'string' ? data.url.trim() : '';
    if (/^https?:\/\//i.test(url)) return url;
  } catch (_) { /* 忽略，继续降级 */ }
  return null;
}

/** 兼容旧调用：返回第一个可用直链 */
async function resolveUrl(song, quality) {
  const list = await resolveUrls(song, quality);
  return list[0] || null;
}

/**
 * 解析播放直链，返回候选列表（按优先级排序，播放失败依次切换）
 * 网易云：自建落月（音质最全）→ meting 镜像 → gdstudio
 * QQ音乐：官方落月 → 自建落月
 */
async function resolveUrls(song, quality) {
  const list = [];
  const push = (u) => { if (u && typeof u === 'string' && !list.includes(u)) list.push(u); };

  if (song.platform === 'tencent') {
    const q = parseInt(quality, 10);
    const qqQuality = QQ_QUALITY_VALUES.includes(q) ? q : 4;
    const key = song.mid ? 'mid=' + song.mid : 'id=' + song.id;
    for (const base of [OFFICIAL, SELF]) {
      try {
        const data = await getJson(`${base}/v2/music/tencent?${key}&quality=${qqQuality}`);
        if (data && data.code === 200 && data.data && data.data.url) push(data.data.url);
      } catch (_) { /* 尝试下一个源 */ }
    }
    push(song.url);
    return list;
  }

  const fromSelf = await getNeteaseFromSelf(song.id, quality);
  if (fromSelf && fromSelf.url) push(fromSelf.url);
  for (const u of await getMetingUrls(song.id)) push(u);
  push(await getGdStudioUrl('netease', song.id));
  push(song.url);
  return list;
}

// ============ 原生插件调用（nativePromise 直连原生 bridge） ============

/** 直接调用原生 MusicDownloader.download */
function nativeDownload(opts) {
  if (window.Capacitor && window.Capacitor.nativePromise) {
    return window.Capacitor.nativePromise('MusicDownloader', 'download', opts);
  }
  return Promise.reject(new Error('原生桥接不可用'));
}

/** 直接调用原生 MusicDownloader.query（查询下载状态） */
function nativeQueryDownload(downloadId) {
  if (window.Capacitor && window.Capacitor.nativePromise) {
    return window.Capacitor.nativePromise('MusicDownloader', 'query', { downloadId });
  }
  return Promise.reject(new Error('原生桥接不可用'));
}

// ============ 界面元素 ============

const $ = (sel) => document.querySelector(sel);
const audioPlayer = $('#audio-player');
const songListEl = $('#song-list');
let results = [];

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function setStatus(ok) {
  $('#status-dot').className = 'status-dot ' + (ok ? 'online' : 'offline');
}

// ============ 音质下拉（按平台动态切换） ============

const QUALITY_OPTIONS = {
  netease: [
    ['1', '标准 64k'], ['2', '标准 128k'], ['3', 'HQ 192k'], ['4', 'HQ 320k'],
    ['5', 'SQ 无损'], ['6', 'Hi-Res'], ['7', 'Spatial'], ['8', 'Surround'], ['9', 'Master'],
  ],
  tencent: [
    ['4', '标准'], ['8', 'HQ'], ['10', 'SQ无损'], ['11', 'Hi-Res'], ['12', '杜比'], ['14', '母带2.0'],
  ],
  aggregation: [
    ['5', '网易 SQ / QQ SQ'], ['3', '网易 HQ / QQ 标准'],
    ['6', '网易 Hi-Res'], ['9', '网易 Master'],
  ],
};

function refreshQuality(platform) {
  const sel = $('#quality');
  const list = QUALITY_OPTIONS[platform] || QUALITY_OPTIONS.netease;
  sel.innerHTML = list.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
  sel.value = list[0][0];
}

$('#platform').addEventListener('change', () => refreshQuality($('#platform').value));
refreshQuality('netease');

// ============ 搜索 ============

async function doSearch() {
  const keyword = $('#keyword').value.trim();
  if (!keyword) return toast('请输入关键词');

  const platform = $('#platform').value;
  const quality = parseInt($('#quality').value, 10);
  const qualityNetease = platform === 'tencent' ? 5 : quality;
  const qualityQQ = platform === 'netease' ? 10 : quality;

  $('#empty-tip').style.display = 'none';
  $('#loading-tip').style.display = 'block';
  songListEl.innerHTML = '';
  $('#result-count').textContent = '';

  try {
    results = await search(keyword, platform, 30, qualityNetease, qualityQQ);
    if (!results.length) {
      $('#empty-tip').textContent = '没有找到相关歌曲 😢';
      $('#empty-tip').style.display = 'block';
      setStatus(true);
      return;
    }
    setStatus(true);
    renderResults();
  } catch (err) {
    console.error(err);
    setStatus(false);
    $('#empty-tip').textContent = '搜索失败：' + (err.message || err);
    $('#empty-tip').style.display = 'block';
  } finally {
    $('#loading-tip').style.display = 'none';
  }
}

// ============ 结果渲染 ============

function formatDuration(ms) {
  if (!ms || ms <= 0) return '';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderResults() {
  songListEl.innerHTML = '';
  $('#result-count').textContent = results.length + ' 首';

  results.forEach((song, index) => {
    const li = document.createElement('li');
    li.className = 'song-card';
    li.dataset.index = index;

    const cover = song.cover
      ? `<img class="song-cover" src="${escapeHtml(song.cover)}" alt="" onerror="this.style.visibility='hidden'" />`
      : '<div class="song-cover"></div>';

    const meta = [song.artist, song.album, formatDuration(song.duration)].filter(Boolean).join(' · ');

    li.innerHTML = `
      ${cover}
      <div class="song-body">
        <div class="song-name">${escapeHtml(song.name)}</div>
        <div class="song-meta">${escapeHtml(meta)}</div>
        <div class="song-tags">
          <span class="badge badge-${song.platform}">${PLATFORM_LABEL[song.platform] || '未知'}</span>
          ${song.quality ? `<span class="song-meta">${escapeHtml(String(song.quality))}</span>` : ''}
        </div>
      </div>
      <div class="song-actions">
        <button class="btn-play" data-index="${index}">播放</button>
        <button class="btn-download" data-index="${index}">下载</button>
      </div>
      <div class="dl-progress" style="display:none">
        <div class="dl-progress-bar"><div class="dl-progress-fill"></div></div>
        <span class="dl-progress-text">0%</span>
      </div>`;

    li.querySelector('.song-body').addEventListener('click', () => playSong(index));
    li.querySelector('.btn-play').addEventListener('click', () => playSong(index));
    li.querySelector('.btn-download').addEventListener('click', () => downloadSong(index));
    songListEl.appendChild(li);
  });
}

// ============ 在线播放 ============

let currentIndex = -1;

function setPlayIcon(playing) {
  $('#btn-play').innerHTML = playing
    ? '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
}

/** 当前选中的音质（按平台映射为接口合法值） */
function currentQuality(platform) {
  const raw = parseInt($('#quality').value, 10);
  const q = Number.isFinite(raw) && raw > 0 ? raw : (platform === 'tencent' ? 4 : 2);
  if (platform === 'tencent') return QQ_QUALITY_VALUES.includes(q) ? q : 4;
  return Math.min(q, 9);
}

let playCandidates = [];
let pendingAttempt = null;

/** 当前候选地址播放失败时，自动切换到下一个候选 */
async function failAttempt(reason) {
  const next = typeof pendingAttempt === 'number' ? pendingAttempt + 1 : -1;
  pendingAttempt = null;
  if (next >= 0 && next < playCandidates.length) {
    toast('当前音源不可用，正在切换音源…');
    await playAttempt(next);
    return;
  }
  setPlayIcon(false);
  toast(reason || '播放失败：所有音源均不可用');
}

async function playAttempt(i) {
  const url = playCandidates[i];
  if (!url) return failAttempt();
  pendingAttempt = i;
  audioPlayer.src = url;
  audioPlayer.load();
  try {
    await audioPlayer.play();
  } catch (err) {
    console.warn('play() 未成功', err);
    // 链接不可用会触发 error 事件（自动降级）；自动播放被拦截则提示手动点击
    if (err && err.name === 'NotAllowedError') {
      pendingAttempt = null;
      setPlayIcon(false);
      toast('请点击播放按钮开始播放');
    }
  }
}

async function playSong(index) {
  if (!results[index]) return;
  const song = results[index];
  currentIndex = index;

  $('#mini-title').textContent = song.name;
  $('#mini-artist').textContent = song.artist;
  if (song.cover) $('#mini-cover').src = song.cover;
  $('#mini-player').classList.remove('hidden');
  setPlayIcon(true);
  highlightCurrent(index);

  const platform = song.platform || 'netease';
  const quality = currentQuality(platform);

  try {
    playCandidates = await resolveUrls(song, quality);
    if (!playCandidates.length) {
      toast('获取播放链接失败：所有音源均未返回直链');
      setPlayIcon(false);
      return;
    }
    await playAttempt(0);
  } catch (err) {
    console.error(err);
    toast('播放失败：' + (err.message || err));
    setPlayIcon(false);
  }
}

function highlightCurrent(index) {
  Array.from(songListEl.children).forEach((li) => {
    li.classList.toggle('playing', Number(li.dataset.index) === index);
  });
}

audioPlayer.addEventListener('play', () => setPlayIcon(true));
audioPlayer.addEventListener('pause', () => setPlayIcon(false));
audioPlayer.addEventListener('playing', () => { pendingAttempt = null; });
audioPlayer.addEventListener('error', () => {
  if (typeof pendingAttempt === 'number') failAttempt();
});
audioPlayer.addEventListener('ended', () => {
  if (currentIndex >= 0 && currentIndex < results.length - 1) {
    playSong(currentIndex + 1);
  } else {
    setPlayIcon(false);
  }
});

let seekDragging = false;

function formatPlayTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

audioPlayer.addEventListener('loadedmetadata', () => {
  const dur = audioPlayer.duration;
  if (dur && Number.isFinite(dur)) {
    $('#mini-dur').textContent = formatPlayTime(dur);
  }
});

audioPlayer.addEventListener('timeupdate', () => {
  const cur = audioPlayer.currentTime;
  const dur = audioPlayer.duration;
  if (dur && Number.isFinite(dur)) {
    if (!seekDragging) {
      $('#mini-seek').value = Math.round((cur / dur) * 1000);
    }
    $('#mini-cur').textContent = formatPlayTime(cur);
  }
});

// 进度条拖动（松开时跳转播放位置）
$('#mini-seek').addEventListener('input', () => {
  seekDragging = true;
});
$('#mini-seek').addEventListener('change', (e) => {
  seekDragging = false;
  const dur = audioPlayer.duration;
  if (dur && Number.isFinite(dur)) {
    audioPlayer.currentTime = (Number(e.target.value) / 1000) * dur;
  }
});

// ============ 播放器控制 ============

$('#btn-play').addEventListener('click', () => {
  if (audioPlayer.paused) {
    if (audioPlayer.src) audioPlayer.play().catch(() => toast('播放失败'));
    else if (currentIndex >= 0) playSong(currentIndex);
  } else {
    audioPlayer.pause();
  }
});

$('#btn-prev').addEventListener('click', () => {
  if (currentIndex > 0) playSong(currentIndex - 1);
});

$('#btn-next').addEventListener('click', () => {
  if (currentIndex >= 0 && currentIndex < results.length - 1) playSong(currentIndex + 1);
});

$('#btn-stop').addEventListener('click', () => {
  audioPlayer.pause();
  audioPlayer.removeAttribute('src');
  audioPlayer.load();
  setPlayIcon(false);
  $('#mini-player').classList.add('hidden');
  $('#mini-seek').value = 0;
  $('#mini-cur').textContent = '00:00';
  $('#mini-dur').textContent = '00:00';
  highlightCurrent(-1);
  currentIndex = -1;
});

// ============ 原生下载（DownloadManager） ============

function updateDownloadProgress(index, s) {
  const li = songListEl.children[index];
  if (!li) return;
  const bar = li.querySelector('.dl-progress');
  const fill = li.querySelector('.dl-progress-fill');
  const text = li.querySelector('.dl-progress-text');
  if (!bar) return;
  if (s.done || s.failed) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  const pct = s.total > 0 ? Math.min(99, Math.round((s.received / s.total) * 100)) : 0;
  fill.style.width = pct + '%';
  text.textContent = pct + '%';
}

function pollDownloadStatus(id, index, attempts) {
  setTimeout(async () => {
    try {
      const s = await nativeQueryDownload(id);
      if (s) {
        updateDownloadProgress(index, s);
        if (s.done) {
          toast('✅ 下载完成，请在「下载」目录查看');
        } else if (s.failed) {
          const reasonMap = {
            1001: '网络中断', 1002: '服务器无响应', 1003: '服务器未响应（重定向问题）',
            1004: '目标文件已存在', 1005: '存储空间不足', 1006: '目标文件过大',
          };
          toast('❌ 下载失败：' + (reasonMap[s.reason] || ('错误码 ' + s.reason)));
        } else if (attempts < 300) { // 最多轮询约 5 分钟
          pollDownloadStatus(id, index, attempts + 1);
        }
      }
    } catch (_) {
      // 查询失败则静默停止轮询
    }
  }, 1000);
}

async function downloadSong(index) {
  const song = results[index];
  if (!song) return;

  toast('正在获取下载链接…');
  const platform = song.platform || 'netease';
  const quality = currentQuality(platform);

  try {
    const urls = await resolveUrls(song, quality);
    if (!urls.length) {
      toast('获取下载链接失败：所有音源均未返回直链');
      return;
    }
    const filename = `${song.name} - ${song.artist}.mp3`;
    let started = null;
    let lastError = '';
    for (const url of urls.slice(0, 3)) {
      const res = await nativeDownload({ url, title: filename });
      if (res && res.ok) { started = res; break; }
      lastError = (res && res.error) || '未知错误';
    }
    if (started) {
      toast('已开始下载（通知栏查看进度）');
      pollDownloadStatus(started.downloadId, index, 0);
    } else {
      toast('下载失败：' + (lastError || '未知错误'));
    }
  } catch (err) {
    console.error(err);
    toast('下载失败：' + (err.message || err));
  }
}

// ============ 事件绑定 ============

$('#search-btn').addEventListener('click', doSearch);
$('#keyword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});
