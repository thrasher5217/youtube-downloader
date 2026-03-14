const express = require('express');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Write YouTube cookies from env variable to a temp file
const COOKIES_PATH = path.join(os.tmpdir(), 'cookies.txt');

function setupCookies() {
  const cookieData = process.env.YT_COOKIES;
  if (cookieData) {
    fs.writeFileSync(COOKIES_PATH, cookieData, 'utf-8');
    console.log('YouTube cookies loaded from environment variable');
    return true;
  }
  console.log('No YT_COOKIES env variable found — running without cookies');
  return false;
}

const hasCookies = setupCookies();

// Build yt-dlp args with optional cookies
function withCookies(args) {
  if (hasCookies) {
    return ['--cookies', COOKIES_PATH, ...args];
  }
  return args;
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Helper: check if a format's language is English or original
function isEnglishOrOriginal(f) {
  const lang = (f.language || '').toLowerCase();
  // Keep formats with: no language set, English, or 'original' tag
  if (!lang || lang === 'en' || lang === 'eng' || lang === 'en-us' || lang === 'en-gb') return true;
  if (lang === 'original' || lang === 'und') return true;
  // Also keep if the format_note or language_preference suggests original/default
  if (f.language_preference != null && f.language_preference >= 0) return true;
  return false;
}

// Get video info
app.get('/api/info', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  if (!url.match(/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  const args = withCookies([
    '--dump-json',
    '--no-warnings',
    '--no-playlist',
    '--no-check-formats',
    '--ignore-errors',
    '--extractor-args', 'youtube:lang=en',
    url
  ]);

  execFile('yt-dlp', args, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      console.error('yt-dlp error:', stderr || err.message);
      return res.status(500).json({ error: 'Failed to fetch video info. Make sure yt-dlp is installed.' });
    }

    try {
      const data = JSON.parse(stdout);

      const formats = (data.formats || [])
        .filter(f => (f.vcodec !== 'none' || f.acodec !== 'none') && isEnglishOrOriginal(f))
        .map(f => ({
          formatId: f.format_id,
          ext: f.ext,
          resolution: f.resolution || (f.height ? `${f.width || '?'}x${f.height}` : 'audio only'),
          fps: f.fps || null,
          filesize: f.filesize || f.filesize_approx || null,
          vcodec: f.vcodec !== 'none' ? f.vcodec : null,
          acodec: f.acodec !== 'none' ? f.acodec : null,
          hasVideo: f.vcodec !== 'none',
          hasAudio: f.acodec !== 'none',
          tbr: f.tbr || null,
          note: f.format_note || '',
          language: f.language || null
        }));

      const combined = formats.filter(f => f.hasVideo && f.hasAudio);
      const videoOnly = formats.filter(f => f.hasVideo && !f.hasAudio);
      const audioOnly = formats.filter(f => !f.hasVideo && f.hasAudio);

      res.json({
        title: data.title,
        thumbnail: data.thumbnail,
        duration: data.duration_string || data.duration,
        uploader: data.uploader,
        viewCount: data.view_count,
        combined,
        videoOnly,
        audioOnly
      });
    } catch (parseErr) {
      console.error('Parse error:', parseErr);
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

// Download a specific format
app.get('/api/download', (req, res) => {
  const { url, formatId, title, ext } = req.query;
  if (!url || !formatId) {
    return res.status(400).json({ error: 'Missing url or formatId parameter' });
  }

  if (!url.match(/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  const safeTitle = (title || 'download').replace(/[^\w\s\-]/g, '').trim().substring(0, 100);
  const extension = (ext || 'mp4').replace(/[^\w]/g, '');
  const filename = `${safeTitle}.${extension}`;

  const mimeTypes = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
    wav: 'audio/wav',
  };

  const contentType = mimeTypes[extension] || 'application/octet-stream';

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', contentType);

  // Prefer: requested format with best English audio, then requested format with any best audio, then just the format
  const formatStr = `${formatId}+ba[language=en]/${formatId}+ba/${formatId}/best`;

  const args = withCookies([
    '-f', formatStr,
    '--no-check-formats',
    '--ignore-errors',
    '--no-playlist',
    '--extractor-args', 'youtube:lang=en',
    '--audio-multistreams',
    '-o', '-',
    url
  ]);

  const ytdlp = spawn('yt-dlp', args);

  ytdlp.stdout.pipe(res);

  ytdlp.stderr.on('data', (data) => {
    console.error('yt-dlp download stderr:', data.toString());
  });

  ytdlp.on('error', (err) => {
    console.error('yt-dlp spawn error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed' });
    }
  });

  ytdlp.on('close', (code) => {
    if (code !== 0 && !res.headersSent) {
      res.status(500).json({ error: 'Download failed' });
    }
  });

  req.on('close', () => {
    ytdlp.kill();
  });
});

// ========== GIF Maker ==========
app.get('/api/gif', (req, res) => {
  const { url, start, duration } = req.query;
  if (!url || start == null || !duration) {
    return res.status(400).json({ error: 'Missing url, start, or duration parameter' });
  }

  if (!url.match(/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  const dur = Math.min(Math.max(parseFloat(duration) || 3, 1), 30);
  const id = crypto.randomBytes(8).toString('hex');
  const tmpDir = os.tmpdir();
  const videoPath = path.join(tmpDir, `ytgif_${id}.mp4`);
  const palettePath = path.join(tmpDir, `ytgif_${id}_palette.png`);
  const gifPath = path.join(tmpDir, `ytgif_${id}.gif`);

  function cleanup() {
    [videoPath, palettePath, gifPath].forEach(f => {
      try { fs.unlinkSync(f); } catch (_) { }
    });
  }

  // Step 1: Download the video segment with yt-dlp
  const dlArgs = withCookies([
    '-f', 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b',
    '--no-playlist',
    '--no-check-formats',
    '--ignore-errors',
    '--download-sections', `*${start}-${parseFloat(start) + dur}`,
    '--force-keyframes-at-cuts',
    '-o', videoPath,
    '--merge-output-format', 'mp4',
    url
  ]);

  console.log(`[GIF] Downloading segment: start=${start}, duration=${dur}`);

  const dlProc = spawn('yt-dlp', dlArgs);
  let dlStderr = '';

  dlProc.stderr.on('data', d => { dlStderr += d.toString(); });

  dlProc.on('error', err => {
    console.error('[GIF] yt-dlp spawn error:', err);
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: 'Failed to start download' });
  });

  dlProc.on('close', code => {
    if (code !== 0) {
      console.error('[GIF] yt-dlp failed:', dlStderr);
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: 'Failed to download video segment' });
      return;
    }

    if (!fs.existsSync(videoPath)) {
      console.error('[GIF] Downloaded file not found');
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: 'Downloaded file not found' });
      return;
    }

    console.log('[GIF] Download complete, generating palette...');

    // Step 2: Generate palette
    const paletteArgs = [
      '-y', '-i', videoPath,
      '-vf', 'fps=15,scale=480:-1:flags=lanczos,palettegen=stats_mode=diff',
      palettePath
    ];

    execFile('ffmpeg', paletteArgs, { timeout: 30000 }, (err) => {
      if (err) {
        console.error('[GIF] Palette generation failed:', err.message);
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: 'GIF palette generation failed' });
        return;
      }

      console.log('[GIF] Palette done, rendering GIF...');

      // Step 3: Generate GIF using the palette
      const gifArgs = [
        '-y', '-i', videoPath, '-i', palettePath,
        '-lavfi', 'fps=15,scale=480:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
        gifPath
      ];

      execFile('ffmpeg', gifArgs, { timeout: 120000, maxBuffer: 50 * 1024 * 1024 }, (err2) => {
        if (err2) {
          console.error('[GIF] GIF rendering failed:', err2.message);
          cleanup();
          if (!res.headersSent) res.status(500).json({ error: 'GIF rendering failed' });
          return;
        }

        console.log('[GIF] GIF ready, streaming to client...');

        const stat = fs.statSync(gifPath);
        res.setHeader('Content-Type', 'image/gif');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Content-Disposition', 'attachment; filename="youtube.gif"');

        const stream = fs.createReadStream(gifPath);
        stream.pipe(res);
        stream.on('end', cleanup);
        stream.on('error', () => {
          cleanup();
          if (!res.headersSent) res.status(500).json({ error: 'Failed to send GIF' });
        });
      });
    });
  });

  req.on('close', () => {
    dlProc.kill();
    cleanup();
  });
});

app.listen(PORT, () => {
  console.log(`YouTube Downloader running at http://localhost:${PORT}`);
});
