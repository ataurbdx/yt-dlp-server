import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Helper: Clean YouTube URL
function cleanYouTubeUrl(raw) {
  const trimmed = (raw || '').trim();
  const match = trimmed.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/i);
  return match && match[1] ? `https://www.youtube.com/watch?v=${match[1]}` : trimmed;
}

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Tour Lyrics yt-dlp Transcoder Bridge',
    message: 'Backend API is running and ready for Android / Web downloads!',
    endpoints: ['/health', '/download', '/info'],
  });
});

// Health check endpoint (supports both /health and /api/audio/health)
app.get(['/health', '/api/audio/health'], (req, res) => {
  res.json({
    status: 'online',
    version: '1.3.0-visionos',
    service: 'Tour Lyrics yt-dlp Transcoder Bridge',
    time: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
  });
});

// Helper: Get or write cookies if provided
function getCookiesPath() {
  const localCookies = path.join(process.cwd(), 'cookies.txt');
  if (fs.existsSync(localCookies)) {
    return localCookies;
  }
  if (process.env.YOUTUBE_COOKIES && process.env.YOUTUBE_COOKIES.trim()) {
    const tmpCookies = path.join(os.tmpdir(), 'yt_cookies.txt');
    try {
      fs.writeFileSync(tmpCookies, process.env.YOUTUBE_COOKIES.trim(), 'utf8');
      return tmpCookies;
    } catch (e) {
      console.warn('Failed to write YOUTUBE_COOKIES to temp file:', e.message);
    }
  }
  return null;
}

// Extract track metadata without downloading
app.post(['/info', '/api/audio/info'], async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  const cleanUrl = cleanYouTubeUrl(url);
  const infoArgs = [
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--extractor-args',
    'youtube:player_client=visionos,android,web',
    '--remote-components',
    'ejs:github',
    '--js-runtimes',
    'node',
  ];

  const cookiesPath = req.query?.nocookies || req.body?.nocookies ? null : getCookiesPath();
  if (cookiesPath) {
    infoArgs.push('--cookies', cookiesPath);
  }

  infoArgs.push(cleanUrl);

  const ytdlp = spawn('yt-dlp', infoArgs);

  let stdout = '';
  let stderr = '';

  ytdlp.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  ytdlp.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  ytdlp.on('close', (code) => {
    if (code !== 0) {
      return res.status(500).json({ error: stderr || 'yt-dlp metadata extraction failed' });
    }
    try {
      const data = JSON.parse(stdout);
      res.json({
        id: data.id,
        title: data.title,
        duration: data.duration,
        thumbnail: data.thumbnail,
        artist: data.artist || data.uploader,
        viewCount: data.view_count,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse metadata JSON' });
    }
  });
});

// Download & transcode audio stream to client (supports both /download and /api/audio/download)
app.get(['/download', '/api/audio/download'], (req, res) => {
  const url = String(req.query.url || '').trim();
  const format = String(req.query.format || 'mp3').toLowerCase();
  const quality = String(req.query.quality || '320k').toLowerCase().replace('kbps', 'k');

  if (!url) {
    return res.status(400).json({ error: 'Query parameter "url" is required' });
  }

  const cleanUrl = cleanYouTubeUrl(url);
  const supportedFormats = ['mp3', 'm4a', 'opus', 'wav', 'flac'];
  const cleanFormat = supportedFormats.includes(format) ? format : 'mp3';
  const cleanQuality = ['320k', '256k', '192k', '128k'].includes(quality) ? quality : '320k';

  const mimeTypes = {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    opus: 'audio/opus',
    wav: 'audio/wav',
    flac: 'audio/flac',
  };

  const tempId = `yt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tempDir = os.tmpdir();
  const tempPrefix = path.join(tempDir, tempId);

  const ytdlpArgs = [
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--extractor-args',
    'youtube:player_client=visionos,android,web',
    '--remote-components',
    'ejs:github',
    '--js-runtimes',
    'node',
    '-f',
    'ba/b',
    '--max-filesize',
    '65M',
    '-x',
    '--audio-format',
    cleanFormat,
    '--audio-quality',
    cleanQuality,
  ];

  const cookiesPath = req.query.nocookies ? null : getCookiesPath();
  if (cookiesPath) {
    ytdlpArgs.push('--cookies', cookiesPath);
  }

  ytdlpArgs.push('-o', `${tempPrefix}.%(ext)s`, cleanUrl);

  let responded = false;
  const sendJson = (status, data) => {
    if (responded || res.headersSent) return;
    responded = true;
    res.status(status).json(data);
  };

  try {
    const child = spawn('yt-dlp', ytdlpArgs);
    let stderr = '';

    const timeout = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      sendJson(504, { error: 'Audio download timed out after 75 seconds.' });
    }, 75000);

    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      sendJson(500, { error: `Process execution error: ${err.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (responded || res.headersSent) return;

      if (code !== 0) {
        const cleanErr = stderr
          .replace(/WARNING:.*\n?/g, '')
          .replace(/ERROR: \[youtube\] /g, '')
          .trim();
        return sendJson(500, {
          error: cleanErr || 'Failed to extract audio from YouTube. The video may be restricted or unavailable.',
        });
      }

      const expectedFile = `${tempPrefix}.${cleanFormat}`;
      if (!fs.existsSync(expectedFile)) {
        const files = fs.readdirSync(tempDir).filter((f) => f.startsWith(tempId));
        if (files.length > 0) {
          const matchPath = path.join(tempDir, files[0]);
          responded = true;
          res.setHeader('Content-Type', mimeTypes[cleanFormat] || 'audio/mpeg');
          res.setHeader('Content-Disposition', `attachment; filename="tour_audio.${cleanFormat}"`);
          return res.sendFile(matchPath, () => {
            try { fs.unlinkSync(matchPath); } catch {}
          });
        }
        return sendJson(500, { error: 'Extracted audio file not found on server.' });
      }

      responded = true;
      res.setHeader('Content-Type', mimeTypes[cleanFormat] || 'audio/mpeg');
      res.setHeader('Content-Disposition', `attachment; filename="tour_audio.${cleanFormat}"`);
      res.sendFile(expectedFile, () => {
        try { fs.unlinkSync(expectedFile); } catch {}
      });
    });

    req.on('close', () => {
      clearTimeout(timeout);
      try { child.kill('SIGTERM'); } catch {}
    });
  } catch (err) {
    sendJson(500, { error: err?.message || 'Download handler exception' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tour Lyrics yt-dlp server listening on port ${PORT}`);
});
