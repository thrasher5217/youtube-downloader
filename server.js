const express = require('express');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

// Debug endpoint to check what's happening on the server
app.get('/api/debug', (req, res) => {
  const url = req.query.url || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const args = withCookies(['--list-formats', '--no-playlist', url]);

  execFile('yt-dlp', ['--version'], { timeout: 5000 }, (err, version) => {
    const ytdlpVersion = version ? version.trim() : 'NOT FOUND: ' + (err ? err.message : 'unknown');

    execFile('yt-dlp', args, { timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (err2, stdout2, stderr2) => {
      res.json({
        ytdlpVersion,
        hasCookies,
        cookiesFileExists: fs.existsSync(COOKIES_PATH),
        formats: stdout2 || null,
        error: stderr2 || (err2 ? err2.message : null)
      });
    });
  });
});

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
        .filter(f => f.vcodec !== 'none' || f.acodec !== 'none')
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
          note: f.format_note || ''
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

  const args = withCookies([
    '-f', `${formatId}/best`,
    '--no-check-formats',
    '--ignore-errors',
    '--no-playlist',
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

app.listen(PORT, () => {
  console.log(`YouTube Downloader running at http://localhost:${PORT}`);
});
