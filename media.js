const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MB = 1048576;

const VIDEO = new Set(['mp4', 'm4v', 'mov', 'mkv', 'avi', 'webm', 'flv', 'ts', '3gp']);
const AUDIO = new Set(['mp3', 'm4a', 'm4b', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'wma', 'mka']);
const IMAGE = new Set(['gif', 'bmp']);
const NATIVE = new Set([...VIDEO, ...AUDIO, ...IMAGE, 'pdf', 'psd', 'tif', 'tiff']);

let cachedBin;
function ffmpegBin() {
  if (cachedBin) return cachedBin;
  if (process.env.SQUEEZE_FFMPEG) return (cachedBin = process.env.SQUEEZE_FFMPEG);
  try {
    let p = require('ffmpeg-static');
    if (p) {
      p = p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
      if (fs.existsSync(p)) return (cachedBin = p);
    }
  } catch (_) { /* not installed: fall back to ffmpeg on PATH */ }
  return (cachedBin = 'ffmpeg');
}

let availableCache;
function available() {
  if (availableCache !== undefined) return availableCache;
  return (availableCache = new Promise(resolve => {
    try {
      const p = spawn(ffmpegBin(), ['-hide_banner', '-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', code => resolve(code === 0));
    } catch (_) { resolve(false); }
  }));
}

function probe(file) {
  return new Promise(resolve => {
    const p = spawn(ffmpegBin(), ['-hide_banner', '-nostdin', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const info = { duration: 0, bitrate: 0, vcodec: '', acodec: '', width: 0, height: 0, hasVideo: false, hasAudio: false, ok: false };
      const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
      if (d) { info.duration = (+d[1]) * 3600 + (+d[2]) * 60 + (+d[3]); info.ok = true; }
      const b = /bitrate:\s*(\d+)\s*kb\/s/.exec(err);
      if (b) info.bitrate = +b[1];
      for (const line of err.split('\n')) {
        const v = /Stream #\S+.*?: Video: (\w+)/.exec(line);
        if (v && !/attached pic/.test(line) && !info.hasVideo) {
          info.hasVideo = true; info.vcodec = v[1];
          const wh = /,\s*(\d{2,5})x(\d{2,5})/.exec(line);
          if (wh) { info.width = +wh[1]; info.height = +wh[2]; }
        }
        const a = /Stream #\S+.*?: Audio: (\w+)/.exec(line);
        if (a && !info.hasAudio) { info.hasAudio = true; info.acodec = a[1]; }
      }
      if (info.hasVideo || info.hasAudio) info.ok = true;
      resolve(info);
    });
  });
}

const Q = {
  high:  { crf: 22, x265: 26, vp9: 32, aac: 128, mp3: 160, opus: 96, vorbis: 4,   colors: 256, pdfq: 4, pdfMax: 0 },
  bal:   { crf: 26, x265: 29, vp9: 36, aac: 96,  mp3: 128, opus: 64, vorbis: 3,   colors: 128, pdfq: 6, pdfMax: 2400 },
  small: { crf: 30, x265: 32, vp9: 40, aac: 64,  mp3: 96,  opus: 48, vorbis: 1.5, colors: 64,  pdfq: 9, pdfMax: 1700 }
};
const MUXER = { mp4: 'mp4', m4v: 'mp4', mov: 'mov', mkv: 'matroska', avi: 'avi', webm: 'webm', flv: 'flv',
  mp3: 'mp3', m4a: 'ipod', m4b: 'ipod', ts: 'mpegts', '3gp': '3gp', wma: 'asf', mka: 'matroska', aac: 'adts', ogg: 'ogg', oga: 'ogg', opus: 'opus', flac: 'flac', wav: 'wav', gif: 'gif' };

function recipe(ext, qName, info, threads, withSubs) {
  const P = Q[qName] || Q.bal, t = String(Math.max(1, threads | 0));
  const base = ['-map_metadata', '0', '-threads', t];

  if (ext === 'gif') {
    return { args: ['-an', '-vf', `split[a][b];[a]palettegen=max_colors=${P.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', '-f', 'gif'] };
  }
  if (ext === 'bmp') {
    return { args: ['-frames:v', '1', '-vf', `split[a][b];[a]palettegen=max_colors=${P.colors}[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`, '-pix_fmt', 'pal8', '-c:v', 'bmp', '-f', 'image2', '-update', '1'] };
  }

  const isVideo = VIDEO.has(ext) && info.hasVideo;
  if (!isVideo) {
    if (!info.hasAudio) return { skip: 'no audio or video stream' };
    const kb = { mp3: P.mp3, m4a: P.aac, m4b: P.aac, aac: P.aac, opus: P.opus, wma: P.aac, mka: P.opus }[ext] || P.aac;
    if (['mp3', 'm4a', 'm4b', 'aac', 'opus', 'wma'].includes(ext) && info.bitrate && info.bitrate <= kb * 1.05) return { skip: 'already small' };
    switch (ext) {
      case 'mp3':  return { args: [...base, '-map', '0:a', '-map', '0:v?', '-c:v', 'copy', '-c:a', 'libmp3lame', '-b:a', kb + 'k', '-id3v2_version', '3', '-f', 'mp3'] };
      case 'wma':  return { args: [...base, '-vn', '-c:a', 'wmav2', '-b:a', kb + 'k', '-f', 'asf'] };
      case 'mka':  return { args: [...base, '-map', '0:a', '-c:a', 'libopus', '-b:a', kb + 'k', '-f', 'matroska'] };
      case 'm4b':
      case 'm4a':  return { args: [...base, '-map', '0:a', '-map', '0:v?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', kb + 'k', '-movflags', '+faststart', '-f', 'ipod'] };
      case 'aac':  return { args: [...base, '-vn', '-c:a', 'aac', '-b:a', kb + 'k', '-f', 'adts'] };
      case 'opus': return { args: [...base, '-vn', '-c:a', 'libopus', '-b:a', kb + 'k', '-f', 'opus'] };
      case 'ogg': case 'oga': return { args: [...base, '-vn', '-c:a', 'libvorbis', '-q:a', String(P.vorbis), '-f', 'ogg'] };
      case 'flac': return { args: [...base, '-map', '0:a', '-map', '0:v?', '-c:v', 'copy', '-c:a', 'flac', '-compression_level', '12', '-f', 'flac'] };
      case 'wav':
        if (qName === 'high') return { args: [...base, '-vn', '-c:a', 'pcm_s16le', '-f', 'wav'] };
        return { args: [...base, '-vn', '-c:a', 'adpcm_ima_wav', ...(qName === 'small' ? ['-ar', '22050'] : []), '-f', 'wav'] };
      case 'mp4': case 'm4v': case 'mov':
        return { args: [...base, '-map', '0:a', '-c:a', 'aac', '-b:a', P.aac + 'k', '-f', MUXER[ext]] };
      case 'mkv': return { args: [...base, '-map', '0:a', '-c:a', 'aac', '-b:a', P.aac + 'k', '-f', 'matroska'] };
      case 'webm': return { args: [...base, '-map', '0:a', '-c:a', 'libopus', '-b:a', P.opus + 'k', '-f', 'webm'] };
      default: return { skip: 'unsupported' };
    }
  }

  const args = [...base, '-map', '0:v:0', '-map', '0:a?'];
  const even = qName === 'small'
    ? "scale=w='min(1920,trunc(iw/2)*2)':h=-2"
    : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  if (ext === 'webm') {
    args.push('-vf', even, '-c:v', 'libvpx-vp9', '-crf', String(P.vp9), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4',
      '-c:a', 'libopus', '-b:a', P.opus + 'k', '-f', 'webm');
    return { args };
  }
  if (info.vcodec === 'hevc') {
    args.push('-vf', even, '-c:v', 'libx265', '-crf', String(P.x265), '-preset', 'medium', '-pix_fmt', 'yuv420p');
    if (ext === 'mp4' || ext === 'mov' || ext === 'm4v') args.push('-tag:v', 'hvc1');
  } else {
    args.push('-vf', even, '-c:v', 'libx264', '-crf', String(P.crf), '-preset', 'medium', '-pix_fmt', 'yuv420p');
  }
  args.push('-c:a', ext === 'avi' ? 'libmp3lame' : 'aac', '-b:a', P.aac + 'k');
  if (withSubs && ext === 'mkv') args.push('-map', '0:s?', '-c:s', 'copy');
  if (withSubs && (ext === 'mp4' || ext === 'mov' || ext === 'm4v')) args.push('-map', '0:s?', '-c:s', 'mov_text');
  if (ext === 'mp4' || ext === 'mov' || ext === 'm4v') args.push('-movflags', '+faststart');
  args.push('-max_muxing_queue_size', '2048', '-f', MUXER[ext]);
  return { args };
}

function runFfmpeg(inPath, outPath, args, duration, onProgress, procs) {
  return new Promise((resolve, reject) => {
    const full = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', inPath, ...args, '-progress', 'pipe:1', '-nostats', outPath];
    const p = spawn(ffmpegBin(), full, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (procs) procs.add(p);
    let err = '', buf = '';
    p.stderr.on('data', d => { err = (err + d).slice(-4000); });
    p.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && duration > 0 && onProgress) onProgress(Math.min(99, Math.round(+m[1] / 1e6 / duration * 100)));
      }
    });
    p.on('error', reject);
    p.on('close', (code, signal) => {
      if (procs) procs.delete(p);
      if (code === 0) resolve();
      else reject(new Error(signal ? 'cancelled' : (err.trim() || 'ffmpeg exited with ' + code)));
    });
  });
}

async function compressWithFfmpeg(job, outPath, onProgress, procs) {
  const info = await probe(job.inPath);
  if (!info || !info.ok) return { ok: false, reason: 'unreadable' };
  const tries = [true, false];
  let lastErr = null;
  for (const withSubs of tries) {
    const r = recipe(job.ext, job.quality, info, job.threads, withSubs);
    if (r.skip) return { ok: false, reason: r.skip };
    try {
      await runFfmpeg(job.inPath, outPath, r.args, info.duration, onProgress, procs);
      lastErr = null; break;
    } catch (e) {
      lastErr = e; try { fs.unlinkSync(outPath); } catch (_) { /* ignore */ }
      if (String(e.message) === 'cancelled') return { ok: false, reason: 'cancelled' };
      if (!(withSubs && (VIDEO.has(job.ext)))) break;
    }
  }
  if (lastErr) return { ok: false, reason: String(lastErr.message).slice(0, 200) };

  const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  if (size < 64) return { ok: false, reason: 'empty output' };
  if (job.ext !== 'gif' && job.ext !== 'bmp') {
    const out = await probe(outPath);
    if (!out || !out.ok) return { ok: false, reason: 'output unreadable' };
    if (info.duration > 0 && Math.abs(out.duration - info.duration) > Math.max(1.5, info.duration * 0.04)) return { ok: false, reason: 'output length mismatch' };
    if (info.hasVideo && VIDEO.has(job.ext) && !out.hasVideo) return { ok: false, reason: 'output lost video' };
    if (info.hasAudio && !out.hasAudio) return { ok: false, reason: 'output lost audio' };
  }
  return { ok: true, size };
}

function ffJpeg(input, inArgs, outArgs) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', ...inArgs, '-i', 'pipe:0', ...outArgs, '-frames:v', '1', '-f', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const out = [];
    p.stdout.on('data', d => out.push(d));
    p.on('error', reject);
    p.stdin.on('error', () => {});
    p.on('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('jpeg ' + code)));
    p.stdin.end(input);
  });
}

function jpegInfo(b) {
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xFF) { i++; continue; }
    if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { bits: b[i + 4], comps: b[i + 9] };
    i += 2 + len;
  }
  return null;
}
const zlibMod = require('zlib');
const { promisify } = require('util');
const inflateAsync = promisify(zlibMod.inflate), deflateAsync = promisify(zlibMod.deflate);
function readBE(b, off, n) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[off + i]; return v; }
function balancedDict(txt, from) {
  const s = txt.indexOf('<<', from); if (s < 0) return null;
  let d = 0, i = s;
  while (i < txt.length) {
    if (txt.startsWith('<<', i)) { d++; i += 2; }
    else if (txt.startsWith('>>', i)) { d--; i += 2; if (d === 0) return { start: s, end: i }; }
    else i++;
  }
  return null;

function removeKey(d, key) {
  const k = d.indexOf(key); if (k < 0) return d;
  let i = k + key.length; while (/\s/.test(d[i])) i++;
  let end;
  if (d.startsWith('<<', i)) { const bd = balancedDict(d, i); end = bd ? bd.end : i; }
  else if (d[i] === '[') end = d.indexOf(']', i) + 1;
  else { const m = /^\d+\s+\d+\s+R|^[^\s\/<>\[\]]+/.exec(d.slice(i)); end = i + (m ? m[0].length : 0); }
  return d.slice(0, k) + d.slice(end);
}
function pngUnfilter(data, columns, colors, bpc) {
  const bpp = Math.max(1, Math.ceil(colors * bpc / 8)), rowBytes = Math.ceil(columns * colors * bpc / 8), stride = rowBytes + 1;
  if (!rowBytes || data.length % stride) return null;
  const rows = data.length / stride, out = Buffer.alloc(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const f = data[r * stride], src = r * stride + 1, dst = r * rowBytes, up = dst - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = data[src + i], a = i >= bpp ? out[dst + i - bpp] : 0, b = r > 0 ? out[up + i] : 0, c = (i >= bpp && r > 0) ? out[up + i - bpp] : 0;
      let v;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)); break; }
        default: return null;
      }
      out[dst + i] = v & 255;
    }
  }
  return out;

function decodeFlate(raw, dict) {
  let data; try { data = zlibMod.inflateSync(raw); } catch (_) { return null; }
  const pm = /\/Predictor\s+(\d+)/.exec(dict);
  if (!pm || +pm[1] === 1) return data;
  if (+pm[1] < 10) return null;
  const col = /\/Columns\s+(\d+)/.exec(dict), clr = /\/Colors\s+(\d+)/.exec(dict), bpc = /\/BitsPerComponent\s+(\d+)/.exec(dict);
  return pngUnfilter(data, col ? +col[1] : 1, clr ? +clr[1] : 1, bpc ? +bpc[1] : 8);
}

function readXrefChain(buf, txt) {
  const sx = txt.lastIndexOf('startxref'); if (sx < 0) return null;
  const entries = new Map(), seen = new Set();
  let queue = [parseInt(txt.slice(sx + 9, sx + 40).trim(), 10)], newest = null;
  while (queue.length) {
    const pos = queue.shift();
    if (!Number.isFinite(pos) || pos < 0 || pos >= txt.length || seen.has(pos)) continue;
    seen.add(pos);
    let i = pos; while (i < txt.length && /\s/.test(txt[i])) i++;
    let dictText = null;
    if (txt.startsWith('xref', i)) {
      i += 4;
      const subRe = /\s*(\d+)[ \t]+(\d+)[ \t]*\r?\n/y, entRe = /\s*(\d{10})[ \t](\d{5})[ \t]([nf])/y;
      for (;;) {
        subRe.lastIndex = i; const sm = subRe.exec(txt); if (!sm) break;
        i = subRe.lastIndex;
        for (let k = 0; k < +sm[2]; k++) {
          entRe.lastIndex = i; const em = entRe.exec(txt); if (!em) return null;
          i = entRe.lastIndex;
          const n = +sm[1] + k;
          if (!entries.has(n)) entries.set(n, em[3] === 'n' ? { type: 1, a: +em[1], b: +em[2] } : { type: 0, a: 0, b: 0 });
        }
      }
      const ti = txt.indexOf('trailer', i), bd = ti < 0 ? null : balancedDict(txt, ti);
      if (!bd) return null;
      dictText = txt.slice(bd.start, bd.end);
      const xs = /\/XRefStm\s+(\d+)/.exec(dictText), pv = /\/Prev\s+(\d+)/.exec(dictText);
      queue = [...(xs ? [+xs[1]] : []), ...(pv ? [+pv[1]] : []), ...queue];
    } else {
      const om = /(\d+)[ \t]+(\d+)[ \t]+obj/y; om.lastIndex = i;
      if (!om.exec(txt)) return null;
      const bd = balancedDict(txt, om.lastIndex); if (!bd) return null;
      dictText = txt.slice(bd.start, bd.end);
      const sm = /^[ \t\r\n]*stream(\r\n|\n|\r)/.exec(txt.slice(bd.end, bd.end + 12)), lm = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dictText);
      if (!sm || !lm) return null;
      const ds = bd.end + sm[0].length;
      let data = /\/FlateDecode/.test(dictText) ? decodeFlate(buf.subarray(ds, ds + +lm[1]), dictText) : buf.subarray(ds, ds + +lm[1]);
      if (!data) return null;
      const wm = /\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(dictText); if (!wm) return null;
      const W = [+wm[1], +wm[2], +wm[3]], rowLen = W[0] + W[1] + W[2];
      const im = /\/Index\s*\[([^\]]*)\]/.exec(dictText), size = /\/Size\s+(\d+)/.exec(dictText);
      const idx = im ? im[1].trim().split(/\s+/).map(Number) : [0, size ? +size[1] : 0];
      let p = 0;
      for (let k = 0; k + 1 < idx.length; k += 2) for (let n = idx[k]; n < idx[k] + idx[k + 1]; n++) {
        if (p + rowLen > data.length) return null;
        const t = W[0] ? readBE(data, p, W[0]) : 1, a = readBE(data, p + W[0], W[1]), b = readBE(data, p + W[0] + W[1], W[2]);
        p += rowLen;
        if (!entries.has(n)) entries.set(n, { type: t, a, b });
      }
      const pv = /\/Prev\s+(\d+)/.exec(dictText);
      if (pv) queue.push(+pv[1]);
    }
    if (!newest) newest = dictText;
  }
  return newest ? { entries, dictText: newest } : null;
}

async function pdfShrink(job, outPath, procs) {
  const P = Q[job.quality] || Q.bal;
  const st = fs.statSync(job.inPath);
  if (st.size > 400 * MB) return { ok: false, reason: 'pdf too large to rewrite' };
  const buf = fs.readFileSync(job.inPath), txt = buf.toString('latin1');
  if (!txt.startsWith('%PDF-')) return { ok: false, reason: 'not a pdf' };
  if (/\/Encrypt\b/.test(txt)) return { ok: false, reason: 'pdf structure not supported' };
  const modern = /\/Type\s*\/(ObjStm|XRef)\b/.test(txt);

  const objRe = /(\d+)[ \t]+(\d+)[ \t]+obj\b/g, endRe = />>[ \t\r\n]*stream(\r\n|\n|\r)|endobj/g;
  const objs = []; let pos = 0;
  for (;;) {
    objRe.lastIndex = pos;
    const m = objRe.exec(txt);
    if (!m) break;
    const s = m.index;
    if (s > 0 && txt[s - 1] !== '\n' && txt[s - 1] !== '\r') { pos = s + m[0].length; continue; }
    const bodyStart = s + m[0].length;
    endRe.lastIndex = bodyStart;
    const e = endRe.exec(txt);
    if (!e) break;
    const o = { num: +m[1], gen: +m[2], start: s, dictStart: bodyStart, stream: false };
    if (e[0] === 'endobj') { o.end = e.index + 6; o.dictEnd = e.index; }
    else {
      o.stream = true; o.dictEnd = e.index + 2; o.dataStart = e.index + e[0].length;
      const d = txt.slice(o.dictStart, o.dictEnd), lm = /\/Length(?![0-9A-Za-z])\s+(\d+)(?!\s+\d+\s+R)/.exec(d);
      let end = -1;
      if (lm) {
        const cand = o.dataStart + (+lm[1]);
        if (/^[\r\n ]*endstream/.test(txt.slice(cand, cand + 16))) end = cand;
      }
      if (end < 0) {
        const k = txt.indexOf('endstream', o.dataStart);
        if (k < 0) break;
        end = k; if (txt[end - 1] === '\n') end--; if (txt[end - 1] === '\r') end--;
      }
      o.dataEnd = end;
      const es = txt.indexOf('endstream', end), eo = es < 0 ? -1 : txt.indexOf('endobj', es);
      if (eo < 0) break;
      o.end = eo + 6;
    }
    objs.push(o); pos = o.end;
  }
  if (!objs.length) return { ok: false, reason: 'no objects found' };
  const last = new Map(); objs.forEach((o, i) => last.set(o.num, i));
  const dictOf = o => txt.slice(o.dictStart, o.dictEnd);

  let keep, entries = null, trailerSrc = null;
  if (modern) {
    const chain = readXrefChain(buf, txt);
    if (!chain) return { ok: false, reason: 'pdf structure not supported' };
    entries = chain.entries; trailerSrc = chain.dictText;
    keep = objs.filter((o, i) => last.get(o.num) === i && entries.get(o.num) && entries.get(o.num).type === 1
      && !/\/Type\s*\/XRef\b/.test(dictOf(o)) && !(i === 0 && /\/Linearized\b/.test(dictOf(o))));
  } else {
    keep = objs.filter((o, i) => last.get(o.num) === i && !(i === 0 && /\/Linearized\b/.test(dictOf(o))));
  }

  const cands = [];
  for (const o of keep) {
    if (!o.stream) continue;
    const d = dictOf(o);
    if (job.lossless) {
      if (o.dataEnd - o.dataStart < 2048 || /\/Type\s*\/(XRef|ObjStm)\b/.test(d)) continue;
      const lf = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(d), ln = lf ? lf[1].match(/[A-Za-z0-9]+/g) : [];
      if (ln.length === 1 && ln[0] === 'FlateDecode') cands.push({ o, kind: 'reflate', data: buf.subarray(o.dataStart, o.dataEnd), w: 0, h: 0 });
      continue;
    }
    if (o.dataEnd - o.dataStart < 24 * 1024) continue;
    if (!/\/Subtype\s*\/Image\b/.test(d) || /\/ImageMask\s+true/.test(d) || /\/Decode\b|\/Mask\b/.test(d)) continue;
    const fm = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(d);
    const names = fm ? fm[1].match(/[A-Za-z0-9]+/g) : [];
    if (names.length !== 1) continue;
    const bits = /\/BitsPerComponent\s+(\d+)/.exec(d);
    if (bits && +bits[1] !== 8) continue;
    const w = /\/Width\s+(\d+)/.exec(d), h = /\/Height\s+(\d+)/.exec(d);
    if (!w || !h) continue;
    const data = buf.subarray(o.dataStart, o.dataEnd);
    if (names[0] === 'DCTDecode') {
      if (/\/DecodeParms|Indexed|CMYK|\/Lab|Separation|DeviceN/.test(d)) continue;
      const ji = jpegInfo(data);
      if (!ji || ji.bits !== 8 || (ji.comps !== 3 && ji.comps !== 1)) continue;
      cands.push({ o, kind: 'jpeg', comps: ji.comps, data, w: +w[1], h: +h[1] });
    } else if (names[0] === 'FlateDecode') {
      const cs = /\/ColorSpace\s*\/(DeviceRGB|DeviceGray)\b/.exec(d);
      if (!cs) continue;
      const comps = cs[1] === 'DeviceRGB' ? 3 : 1;
      if (data.length < 64 * 1024) continue;
      cands.push({ o, kind: 'flate', comps, data, w: +w[1], h: +h[1], dict: d });
    }
  }
  if (!cands.length) return { ok: false, reason: job.lossless ? 'already small' : 'nothing to shrink in this pdf' };

  let next = 0, done = 0;
  const worker = async () => {
    while (next < cands.length) {
      const c = cands[next++];
      try {
        if (c.kind === 'reflate') {
          const raw = await inflateAsync(c.data), z = await deflateAsync(raw, { level: 9 });
          if (z.length < c.data.length * 0.98 && (await inflateAsync(z)).equals(raw)) { c.out = z; c.nw = 0; c.nh = 0; }
          if (job.onProgress) job.onProgress(Math.round(++done / cands.length * 90));
          continue;
        }
        let src = c.data, inArgs = ['-f', 'mjpeg'];
        if (c.kind === 'flate') {
          const raw = decodeFlate(c.data, c.dict);
          if (!raw || raw.length !== c.w * c.h * c.comps) throw new Error('unusual image');
          src = raw; inArgs = ['-f', 'rawvideo', '-pix_fmt', c.comps === 3 ? 'rgb24' : 'gray', '-s', `${c.w}x${c.h}`];
        }
        const long = Math.max(c.w, c.h), outArgs = [];
        let nw = c.w, nh = c.h;
        if (P.pdfMax && long > P.pdfMax) { const k = P.pdfMax / long; nw = Math.max(1, Math.round(c.w * k)); nh = Math.max(1, Math.round(c.h * k)); outArgs.push('-vf', `scale=${nw}:${nh}:flags=lanczos`); }
        outArgs.push('-q:v', String(P.pdfq), '-pix_fmt', c.comps === 3 ? 'yuvj420p' : 'gray');
        const out = await ffJpeg(src, inArgs, outArgs);
        const ji = jpegInfo(out);
        const limit = c.kind === 'flate' ? 0.7 : 0.9;
        if (ji && ji.comps === c.comps && out.length < c.data.length * limit) { c.out = out; c.nw = nw; c.nh = nh; }
      } catch (_) { /* keep the original picture */ }
      if (job.onProgress) job.onProgress(Math.round(++done / cands.length * 90));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(job.threads | 0 || 1, cands.length)) }, worker));
  const changed = new Map(cands.filter(c => c.out).map(c => [c.o, c]));
  if (!changed.size) return { ok: false, reason: job.lossless ? 'already small' : 'pictures already small' };

  const parts = [buf.subarray(0, keep[0].start)]; let cur = parts[0].length;
  const offsets = new Map();
  const push = b => { parts.push(b); cur += b.length; };
  for (const o of keep) {
    offsets.set(o.num, { off: cur, gen: o.gen });
    const c = changed.get(o);
    if (!c) { push(buf.subarray(o.start, o.end)); push(Buffer.from('\n')); continue; }
    let head = txt.slice(o.start, o.dictEnd);
    if (c.kind === 'flate') {
      head = removeKey(head, '/DecodeParms').replace(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/, '/Filter /DCTDecode');
    }
    head = /\/Length(?![0-9A-Za-z])\s+\d+(\s+\d+\s+R)?/.test(head) ? head.replace(/\/Length(?![0-9A-Za-z])\s+\d+(\s+\d+\s+R)?/, '/Length ' + c.out.length) : head.replace(/>>\s*$/, '/Length ' + c.out.length + '>>');
    if (c.nw !== c.w) head = head.replace(/\/Width\s+\d+/, '/Width ' + c.nw).replace(/\/Height\s+\d+/, '/Height ' + c.nh);
    push(Buffer.from(head + '\nstream\n', 'latin1')); push(c.out); push(Buffer.from('\nendstream\nendobj\n'));
  }
  let root = null, info = null, id = null;
  const trailers = modern ? [trailerSrc] : [...txt.matchAll(/trailer\s*<</g)].map(m => txt.slice(m.index, m.index + 2000));
  for (const seg of trailers) {
    const r = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(seg), i = /\/Info\s+(\d+)\s+(\d+)\s+R/.exec(seg), d = /\/ID\s*\[\s*(<[0-9A-Fa-f]*>|\((?:[^)\\]|\\.)*\))\s*(<[0-9A-Fa-f]*>|\((?:[^)\\]|\\.)*\))\s*\]/.exec(seg);
    if (r) root = r[0]; if (i) info = i[0]; if (d) id = d[0];
  }
  if (!root) return { ok: false, reason: 'no document root' };
  const rootNum = +/\/Root\s+(\d+)/.exec(root)[1];
  if (!offsets.has(rootNum) && !(entries && entries.get(rootNum) && entries.get(rootNum).type === 2)) return { ok: false, reason: 'root object missing' };

  let expected;
  if (!modern) {
    const size = Math.max(...offsets.keys()) + 1, xrefAt = cur;
    let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let n = 1; n < size; n++) {
      const e = offsets.get(n);
      x += e ? String(e.off).padStart(10, '0') + ' ' + String(e.gen).padStart(5, '0') + ' n \n' : '0000000000 00000 f \n';
    }
    x += `trailer\n<< /Size ${size} ${root}${info ? ' ' + info : ''}${id ? ' ' + id : ''} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    push(Buffer.from(x, 'latin1'));
    expected = new Map([...offsets].map(([n, e]) => [n, e]));
  } else {
    const topNum = Math.max(...offsets.keys(), ...entries.keys()) + 1, size = topNum + 1, xrefAt = cur;
    const rows = Buffer.alloc(size * 7);
    for (let n = 0; n < size; n++) {
      let t = 0, a = 0, g = n === 0 ? 65535 : 0;
      if (n === topNum) { t = 1; a = xrefAt; g = 0; }
      else if (offsets.has(n)) { t = 1; a = offsets.get(n).off; g = offsets.get(n).gen; }
      else { const e = entries.get(n); if (e && e.type === 2 && offsets.has(e.a) && e.b < 65536) { t = 2; a = e.a; g = e.b; } }
      rows[n * 7] = t; rows.writeUInt32BE(a >>> 0, n * 7 + 1); rows.writeUInt16BE(g & 0xFFFF, n * 7 + 5);
    }
    const z = zlibMod.deflateSync(rows, { level: 9 });
    push(Buffer.from(`${topNum} 0 obj\n<< /Type /XRef /Size ${size} /W [1 4 2] ${root}${info ? ' ' + info : ''}${id ? ' ' + id : ''} /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, 'latin1'));
    push(z); push(Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`));
    expected = new Map([...offsets].map(([n, e]) => [n, e]));
    expected.set(topNum, { off: xrefAt, gen: 0 });
  }
  const out = Buffer.concat(parts);
  const ot = out.toString('latin1');
  for (const [n, e] of expected) if (!new RegExp('^' + n + '[ \\t]+' + e.gen + '[ \\t]+obj').test(ot.slice(e.off, e.off + 24))) return { ok: false, reason: 'rewritten xref invalid' };
  if (modern) {
    const back = readXrefChain(out, ot);
    if (!back) return { ok: false, reason: 'rewritten xref invalid' };
    for (const [n, e] of expected) { const g = back.entries.get(n); if (!g || g.type !== 1 || g.a !== e.off) return { ok: false, reason: 'rewritten xref invalid' }; }
    for (const [n, e] of entries) if (e.type === 2 && offsets.has(e.a)) { const g = back.entries.get(n); if (!g || g.type !== 2 || g.a !== e.a || g.b !== e.b) return { ok: false, reason: 'rewritten xref invalid' }; }
  }
  fs.writeFileSync(outPath, out);
  return { ok: true, size: out.length };
}

const zlib = require('zlib');

function packbitsDecode(src, start, end, rowBytes) {
  const out = Buffer.alloc(rowBytes); let i = start, o = 0;
  while (i < end && o < rowBytes) {
    const n = src.readInt8(i++);
    if (n >= 0) { const c = n + 1; if (i + c > end || o + c > rowBytes) return null; src.copy(out, o, i, i + c); i += c; o += c; }
    else if (n !== -128) { const c = 1 - n; if (i >= end || o + c > rowBytes) return null; out.fill(src[i++], o, o + c); o += c; }
  }
  return o === rowBytes ? out : null;
}
function packbitsEncode(row) {
  const out = []; const n = row.length; let i = 0;
  while (i < n) {
    let run = 1; while (i + run < n && row[i + run] === row[i] && run < 128) run++;
    if (run >= 2) { out.push(257 - run, row[i]); i += run; }
    else {
      let j = i + 1; while (j < n && j - i < 128 && !(j + 1 < n && row[j] === row[j + 1])) j++;
      out.push(j - i - 1); for (let k = i; k < j; k++) out.push(row[k]); i = j;
    }
  }
  return Buffer.from(out);
}
function predict(raw, rowBytes, depth) {
  const out = Buffer.from(raw);
  for (let r = 0; r + rowBytes <= raw.length; r += rowBytes) {
    if (depth === 8) for (let i = rowBytes - 1; i > 0; i--) out[r + i] = (raw[r + i] - raw[r + i - 1]) & 255;
    else for (let i = rowBytes - 2; i >= 2; i -= 2) out.writeUInt16BE(((raw.readUInt16BE(r + i) - raw.readUInt16BE(r + i - 2)) & 0xFFFF), r + i);
  }
  return out;
}
function unpredict(pred, rowBytes, depth) {
  const out = Buffer.from(pred);
  for (let r = 0; r + rowBytes <= pred.length; r += rowBytes) {
    if (depth === 8) for (let i = 1; i < rowBytes; i++) out[r + i] = (out[r + i] + out[r + i - 1]) & 255;
    else for (let i = 2; i < rowBytes; i += 2) out.writeUInt16BE((out.readUInt16BE(r + i) + out.readUInt16BE(r + i - 2)) & 0xFFFF, r + i);
  }
  return out;
}
function zipPlane(raw, rowBytes, depth, maxLen) {
  const z = zlib.deflateSync(predict(raw, rowBytes, depth), { level: 9 });
  if (z.length + 2 >= maxLen) return null;
  if (!unpredict(zlib.inflateSync(z), rowBytes, depth).equals(raw)) throw new Error('psd self-check failed');
  return z;
}

async function psdShrink(job, outPath) {
  const st = fs.statSync(job.inPath);
  if (st.size > 600 * MB) return { ok: false, reason: 'psd too large to rewrite' };
  const b = fs.readFileSync(job.inPath);
  if (b.length < 40 || b.toString('latin1', 0, 4) !== '8BPS' || b.readUInt16BE(4) !== 1) return { ok: false, reason: 'psd structure not supported' };   // PSB (large) files are left alone
  const nch = b.readUInt16BE(12), H = b.readUInt32BE(14), W = b.readUInt32BE(18), depth = b.readUInt16BE(22);
  if (depth !== 8 && depth !== 16) return { ok: false, reason: 'psd structure not supported' };
  const bpp = depth / 8;
  let p = 26; p += 4 + b.readUInt32BE(p); p += 4 + b.readUInt32BE(p);
  const lmStart = p, lmLen = b.readUInt32BE(p), lmEnd = p + 4 + lmLen;
  if (lmEnd > b.length) return { ok: false, reason: 'psd structure not supported' };
  const head = b.subarray(0, lmStart);
  let layerBlock = Buffer.alloc(0), rest = Buffer.alloc(0), changedAny = false;

  const liLen = lmLen >= 4 ? b.readUInt32BE(lmStart + 4) : 0;
  if (lmLen >= 4 && liLen > 0) {
    const liStart = lmStart + 8, liEnd = liStart + liLen;
    if (liEnd > lmEnd) return { ok: false, reason: 'psd structure not supported' };
    const count = Math.abs(b.readInt16BE(liStart)); let q = liStart + 2;
    const layers = [];
    for (let i = 0; i < count; i++) {
      const L = { top: b.readInt32BE(q), left: b.readInt32BE(q + 4), bottom: b.readInt32BE(q + 8), right: b.readInt32BE(q + 12) };
      const n = b.readUInt16BE(q + 16); L.ch = [];
      for (let c = 0; c < n; c++) L.ch.push({ id: b.readInt16BE(q + 18 + c * 6), len: b.readUInt32BE(q + 20 + c * 6) });
      const extraLen = b.readUInt32BE(q + 18 + n * 6 + 12);
      L.recStart = q; L.recLen = 18 + n * 6 + 16 + extraLen; q += L.recLen; layers.push(L);
    }
    const recEnd = q; let d = recEnd;
    const newData = [];
    for (const L of layers) {
      const w = L.right - L.left, h = L.bottom - L.top;
      for (const c of L.ch) {
        const orig = b.subarray(d, d + c.len); d += c.len; c.out = orig;
        if (c.len < 4 || c.id < -1 || w <= 0 || h <= 0) continue;
        const comp = orig.readUInt16BE(0), rowBytes = w * bpp; let raw = null;
        if (comp === 0 && orig.length - 2 === rowBytes * h) raw = orig.subarray(2);
        else if (comp === 1) {
          const tbl = 2 + h * 2; if (orig.length < tbl) continue;
          const rows = []; let off = tbl, ok = true;
          for (let r = 0; r < h && ok; r++) {
            const n = orig.readUInt16BE(2 + r * 2), row = packbitsDecode(orig, off, off + n, rowBytes);
            if (!row) ok = false; else { rows.push(row); off += n; }
          }
          if (ok && off === orig.length) raw = Buffer.concat(rows);
        }
        if (!raw) continue;
        const z = zipPlane(raw, rowBytes, depth, c.len);
        if (z) { const nb = Buffer.alloc(2 + z.length); nb.writeUInt16BE(3, 0); z.copy(nb, 2); c.out = nb; changedAny = true; }
      }
    }
    const recs = Buffer.from(b.subarray(liStart + 2, recEnd));
    for (const L of layers) L.ch.forEach((c, i) => recs.writeUInt32BE(c.out.length, L.recStart + 20 + i * 6 - (liStart + 2)));
    let li = Buffer.concat([b.subarray(liStart, liStart + 2), recs, ...layers.flatMap(L => L.ch.map(c => c.out))]);
    if (li.length % 2) li = Buffer.concat([li, Buffer.alloc(1)]);
    const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(li.length);
    layerBlock = Buffer.concat([lenBuf, li]);
    rest = b.subarray(liEnd, lmEnd);
  } else {
    layerBlock = lmLen >= 4 ? b.subarray(lmStart + 4, lmEnd) : Buffer.alloc(0);
    rest = Buffer.alloc(0);
  }
  const lmBody = Buffer.concat([layerBlock, rest]), lmHead = Buffer.alloc(4);
  lmHead.writeUInt32BE(lmLen >= 4 && liLen > 0 ? lmBody.length : lmLen);
  const lm = liLen > 0 ? Buffer.concat([lmHead, lmBody]) : b.subarray(lmStart, lmEnd);

  let img = b.subarray(lmEnd);
  if (img.length >= 2 && H > 0 && W > 0) {
    const comp = img.readUInt16BE(0), rowBytes = W * bpp; let raw = null;
    if (comp === 0 && img.length - 2 === rowBytes * H * nch) raw = img.subarray(2);
    else if (comp === 1) {
      const rowsN = H * nch, tbl = 2 + rowsN * 2;
      if (img.length >= tbl) {
        const rows = []; let off = tbl, ok = true;
        for (let r = 0; r < rowsN && ok; r++) {
          const n = img.readUInt16BE(2 + r * 2), row = packbitsDecode(img, off, off + n, rowBytes);
          if (!row) ok = false; else { rows.push(row); off += n; }
        }
        if (ok && off === img.length) raw = Buffer.concat(rows);
      }
    }
    if (raw && comp === 0) {
      const rowsN = H * nch, encRows = [], tbl = Buffer.alloc(rowsN * 2);
      for (let r = 0; r < rowsN; r++) {
        const row = raw.subarray(r * rowBytes, (r + 1) * rowBytes), enc = packbitsEncode(row);
        if (!packbitsDecode(enc, 0, enc.length, rowBytes).equals(row) || enc.length > 65535) { encRows.length = 0; break; }
        encRows.push(enc); tbl.writeUInt16BE(enc.length, r * 2);
      }
      if (encRows.length === rowsN) {
        const nb = Buffer.concat([Buffer.from([0, 1]), tbl, ...encRows]);
        if (nb.length < img.length) { img = nb; changedAny = true; }
      }
    }
  }
  if (!changedAny) return { ok: false, reason: 'already small' };
  const out = Buffer.concat([head, lm, img]);
  fs.writeFileSync(outPath, out);
  return { ok: true, size: out.length };
}


function tiffShrink(job, outPath) {
  const st = fs.statSync(job.inPath);
  if (st.size > 800 * MB) return { ok: false, reason: 'tiff too large to rewrite' };
  const b = fs.readFileSync(job.inPath), bo = b.toString('latin1', 0, 2);
  if ((bo !== 'II' && bo !== 'MM') || b.length < 16) return { ok: false, reason: 'tiff structure not supported' };
  const le = bo === 'II';
  const r16 = o => le ? b.readUInt16LE(o) : b.readUInt16BE(o), r32 = o => le ? b.readUInt32LE(o) : b.readUInt32BE(o);
  const w16 = (buf, v, o) => le ? buf.writeUInt16LE(v, o) : buf.writeUInt16BE(v, o), w32 = (buf, v, o) => le ? buf.writeUInt32LE(v >>> 0, o) : buf.writeUInt32BE(v >>> 0, o);
  if (r16(2) !== 42) return { ok: false, reason: 'tiff structure not supported' };   // BigTIFF etc.
  const TS = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
  const ifds = [], seen = new Set();
  let off = r32(4);
  while (off) {
    if (seen.has(off) || seen.size > 500 || off + 2 > b.length) return { ok: false, reason: 'tiff structure not supported' };
    seen.add(off);
    const n = r16(off), ents = [];
    if (off + 2 + n * 12 + 4 > b.length) return { ok: false, reason: 'tiff structure not supported' };
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12, tag = r16(e), type = r16(e + 2), count = r32(e + 4), sz = TS[type];
      if (!sz) return { ok: false, reason: 'tiff structure not supported' };
      const total = sz * count, vo = total <= 4 ? e + 8 : r32(e + 8);
      if (vo + total > b.length) return { ok: false, reason: 'tiff structure not supported' };
      if ([330, 34665, 34853, 40965, 513].includes(tag)) return { ok: false, reason: 'tiff structure not supported' };
      ents.push({ tag, type, count, data: b.subarray(vo, vo + total) });
    }
    ifds.push(ents); off = r32(off + 2 + n * 12);
  }
  const num = (ents, tag, d) => { const e = ents.find(x => x.tag === tag); if (!e || !e.count) return d; return e.type === 3 ? (le ? e.data.readUInt16LE(0) : e.data.readUInt16BE(0)) : (le ? e.data.readUInt32LE(0) : e.data.readUInt32BE(0)); };
  const arr = e => { const sz = e.type === 3 ? 2 : 4, out = []; for (let i = 0; i < e.count; i++) out.push(sz === 2 ? (le ? e.data.readUInt16LE(i * 2) : e.data.readUInt16BE(i * 2)) : (le ? e.data.readUInt32LE(i * 4) : e.data.readUInt32BE(i * 4))); return out; };
  const rd = (buf, o, w) => w === 2 ? (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)) : buf[o];
  const wr = (buf, v, o, w) => { if (w === 2) w16(buf, v & 0xFFFF, o); else buf[o] = v & 255; };

  const parts = [Buffer.alloc(8)]; let cur = 8, changedAny = false;
  parts[0].write(bo, 0, 'latin1'); w16(parts[0], 42, 2);
  const push = buf => { if (cur % 2) { parts.push(Buffer.alloc(1)); cur++; } const at = cur; parts.push(buf); cur += buf.length; return at; };
  let patchPrev = 4;

  for (const ents of ifds) {
    const tiled = ents.some(e => e.tag === 324);
    const oE = ents.find(e => e.tag === (tiled ? 324 : 273)), cE = ents.find(e => e.tag === (tiled ? 325 : 279));
    if (!oE || !cE || oE.count !== cE.count) return { ok: false, reason: 'tiff structure not supported' };
    const offs = arr(oE), cnts = arr(cE), comp = num(ents, 259, 1);
    const width = tiled ? num(ents, 322, 0) : num(ents, 256, 0), spp = num(ents, 277, 1), planar = num(ents, 284, 1), sfmt = num(ents, 339, 1);
    const bpsE = ents.find(e => e.tag === 258), bps = bpsE ? arr(bpsE) : [1];
    const bytesPer = bps.every(v => v === bps[0]) ? bps[0] / 8 : 0;
    const usePred = comp === 1 && planar === 1 && sfmt === 1 && (bytesPer === 1 || bytesPer === 2) && width > 0 && num(ents, 317, 1) === 1;
    const rowBytes = width * spp * bytesPer;
    let blocks = offs.map((o, i) => b.subarray(o, o + cnts[i]));
    if (blocks.some((x, i) => offs[i] + cnts[i] > b.length || x.length !== cnts[i])) return { ok: false, reason: 'tiff structure not supported' };
    let converted = false, newBlocks = blocks;
    if (comp === 1) {
      const zs = blocks.map(raw => {
        const pred = usePred && raw.length % rowBytes === 0;
        let src = raw;
        if (pred) {
          src = Buffer.from(raw);
          for (let r = 0; r < raw.length; r += rowBytes) for (let j = (rowBytes / bytesPer) - 1; j >= spp; j--) wr(src, rd(raw, r + j * bytesPer, bytesPer) - rd(raw, r + (j - spp) * bytesPer, bytesPer), r + j * bytesPer, bytesPer);
        }
        const z = zlib.deflateSync(src, { level: 9 });
        const back = zlib.inflateSync(z);
        if (pred) for (let r = 0; r < back.length; r += rowBytes) for (let j = spp; j < rowBytes / bytesPer; j++) wr(back, rd(back, r + j * bytesPer, bytesPer) + rd(back, r + (j - spp) * bytesPer, bytesPer), r + j * bytesPer, bytesPer);
        if (!back.equals(raw)) throw new Error('tiff self-check failed');
        return { z, pred };
      });
      const allPred = zs.every(x => x.pred), anyPred = zs.some(x => x.pred);
      if (anyPred && !allPred) { 
        newBlocks = blocks.map(raw => zlib.deflateSync(raw, { level: 9 }));
        newBlocks.usePred = false;
      } else { newBlocks = zs.map(x => x.z); newBlocks.usePred = allPred; }
      const before = blocks.reduce((s, x) => s + x.length, 0), after = newBlocks.reduce((s, x) => s + x.length, 0);
      if (after < before * 0.97) { converted = true; changedAny = true; } else newBlocks = blocks;
    }
    const newOffs = newBlocks.map(blk => push(blk));
    const out = [];
    for (const e of ents) {
      if (e.tag === (tiled ? 324 : 273) || e.tag === (tiled ? 325 : 279)) continue;
      if (converted && (e.tag === 259 || e.tag === 317)) continue;
      out.push(e);
    }
    const mkLong = vals => { const d = Buffer.alloc(vals.length * 4); vals.forEach((v, i) => w32(d, v, i * 4)); return { type: 4, count: vals.length, data: d }; };
    out.push({ tag: tiled ? 324 : 273, ...mkLong(newOffs) }, { tag: tiled ? 325 : 279, ...mkLong(newBlocks.map(x => x.length)) });
    if (converted) {
      const s = v => { const d = Buffer.alloc(2); w16(d, v, 0); return { type: 3, count: 1, data: d }; };
      out.push({ tag: 259, ...s(8) });
      if (newBlocks.usePred) out.push({ tag: 317, ...s(2) });
    }
    out.sort((p, q) => p.tag - q.tag);
    const valOffs = out.map(e => e.data.length > 4 ? push(Buffer.from(e.data)) : 0);
    const dir = Buffer.alloc(2 + out.length * 12 + 4);
    w16(dir, out.length, 0);
    out.forEach((e, i) => {
      const p = 2 + i * 12;
      w16(dir, e.tag, p); w16(dir, e.type, p + 2); w32(dir, e.count, p + 4);
      if (e.data.length > 4) w32(dir, valOffs[i], p + 8); else e.data.copy(dir, p + 8);
    });
    if (cur % 2) { parts.push(Buffer.alloc(1)); cur++; }
    const dirAt = cur;
    if (patchPrev === 4) w32(parts[0], dirAt, 4);
    else { const prevDir = patchPrev; w32(prevDir.buf, dirAt, prevDir.pos); }
    push(dir);
    patchPrev = { buf: dir, pos: 2 + out.length * 12 };
  }
  if (!changedAny) return { ok: false, reason: 'already small' };
  const out = Buffer.concat(parts);
  fs.writeFileSync(outPath, out);
  return { ok: true, size: out.length };
}

const running = new Set();
function cancelAll() { for (const p of running) { try { p.kill(); } catch (_) { /* ignore */ } } }

async function compress(job) {
  if (!NATIVE.has(job.ext)) return { ok: false, reason: 'unsupported' };
  if (job.lossless && (VIDEO.has(job.ext) || AUDIO.has(job.ext) || IMAGE.has(job.ext)) && job.ext !== 'flac') return { ok: false, reason: 'lossless unsupported' };
  if (!(await available())) return { ok: false, reason: 'unavailable' };
  fs.mkdirSync(job.tmpDir, { recursive: true });
  const outPath = path.join(job.tmpDir, job.outName);
  let r;
  try {
    r = job.ext === 'pdf' ? await pdfShrink(job, outPath, running) : job.ext === 'psd' ? await psdShrink(job, outPath) : (job.ext === 'tif' || job.ext === 'tiff') ? tiffShrink(job, outPath) : await compressWithFfmpeg(job, outPath, job.onProgress, running);
  } catch (e) { r = { ok: false, reason: String((e && e.message) || e).slice(0, 200) }; }
  if (r.ok && r.size >= fs.statSync(job.inPath).size) r = { ok: false, reason: 'not smaller' };
  if (!r.ok) { try { fs.unlinkSync(outPath); } catch (_) { /* ignore */ } return r; }
  return { ok: true, path: outPath, size: r.size };
}

module.exports = { NATIVE, VIDEO, AUDIO, IMAGE, available, compress, cancelAll, ffmpegBin, tmpRoot: () => path.join(os.tmpdir(), 'squeeze-' + process.pid) };
