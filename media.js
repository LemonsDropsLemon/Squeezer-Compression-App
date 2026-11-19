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
}
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
}
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
  if (r16(2) !== 42) return { ok: false, reason: 'tiff structure not supported' };
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
const LOSSLESS_NATIVE = new Set(['png', 'jpg', 'jpeg']);

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
function crc32(...bufs) {
  let c = -1;
  for (const b of bufs) for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---- PNG
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'tIME']);
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function pngChunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(head.subarray(4), data), 0);
  return Buffer.concat([head, data, tail]);
}
function unfilterPng(raw, h, rb, st) {
  const pix = Buffer.alloc(h * rb);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (rb + 1)], s = y * (rb + 1) + 1, o = y * rb, p = o - rb;
    if (f === 0) { raw.copy(pix, o, s, s + rb); }
    else if (f === 1) { for (let i = 0; i < rb; i++) pix[o + i] = (raw[s + i] + (i >= st ? pix[o + i - st] : 0)) & 255; }
    else if (f === 2) { for (let i = 0; i < rb; i++) pix[o + i] = (raw[s + i] + (y ? pix[p + i] : 0)) & 255; }
    else if (f === 3) { for (let i = 0; i < rb; i++) pix[o + i] = (raw[s + i] + (((i >= st ? pix[o + i - st] : 0) + (y ? pix[p + i] : 0)) >> 1)) & 255; }
    else if (f === 4) {
      for (let i = 0; i < rb; i++) {
        const a = i >= st ? pix[o + i - st] : 0, b = y ? pix[p + i] : 0, c = (i >= st && y) ? pix[p + i - st] : 0;
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        pix[o + i] = (raw[s + i] + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 255;
      }
    } else return null;
  }
  return pix;
}
function refilterPng(pix, h, rb, st) {
  const out = Buffer.alloc(h * (rb + 1)), zero = Buffer.alloc(rb);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(rb));
  const mag = v => (v < 128 ? v : 256 - v);
  for (let y = 0; y < h; y++) {
    const o = y * rb, row = pix.subarray(o, o + rb), up = y ? pix.subarray(o - rb, o) : zero;
    const sums = [0, 0, 0, 0, 0];
    const c0 = cand[0], c1 = cand[1], c2 = cand[2], c3 = cand[3], c4 = cand[4];
    for (let i = 0; i < rb; i++) {
      const x = row[i], a = i >= st ? row[i - st] : 0, b = up[i], c = i >= st ? up[i - st] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      c0[i] = x; c1[i] = (x - a) & 255; c2[i] = (x - b) & 255; c3[i] = (x - ((a + b) >> 1)) & 255;
      c4[i] = (x - ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 255;
      sums[0] += mag(c0[i]); sums[1] += mag(c1[i]); sums[2] += mag(c2[i]); sums[3] += mag(c3[i]); sums[4] += mag(c4[i]);
    }
    let best = 0;
    for (let f = 1; f < 5; f++) if (sums[f] < sums[best]) best = f;
    out[y * (rb + 1)] = best; cand[best].copy(out, y * (rb + 1) + 1);
  }
  return out;
}
function noFilterPng(pix, h, rb) {
  const out = Buffer.alloc(h * (rb + 1));
  for (let y = 0; y < h; y++) pix.copy(out, y * (rb + 1) + 1, y * rb, (y + 1) * rb);
  return out;
}
function smallestDeflate(raws) {
  let best = null;
  for (const r of raws) {
    for (const strategy of [zlibMod.constants.Z_DEFAULT_STRATEGY, zlibMod.constants.Z_FILTERED]) {
      const z = zlibMod.deflateSync(r.data, { level: 9, memLevel: 9, strategy });
      if (!best || z.length < best.z.length) best = { z, tag: r.tag, data: r.data };
    }
  }
  return best;
}
function pngToRgba(ctype, depth, pix, w, h, plte, trns) {
  const out = Buffer.alloc(w * h * 4), rb = Math.ceil(w * (PNG_CHANNELS[ctype] * depth) / 8), mask = (1 << depth) - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4;
      if (ctype === 2 || ctype === 6) {
        const s = y * rb + x * (ctype === 2 ? 3 : 4);
        out[d] = pix[s]; out[d + 1] = pix[s + 1]; out[d + 2] = pix[s + 2]; out[d + 3] = ctype === 6 ? pix[s + 3] : 255;
      } else if (ctype === 4) {
        const s = y * rb + x * 2; out[d] = out[d + 1] = out[d + 2] = pix[s]; out[d + 3] = pix[s + 1];
      } else {
        const bit = x * depth, v = (pix[y * rb + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
        if (ctype === 0) { const g = depth === 8 ? v : Math.round(v * 255 / mask); out[d] = out[d + 1] = out[d + 2] = g; out[d + 3] = 255; }
        else { out[d] = plte[v * 3]; out[d + 1] = plte[v * 3 + 1]; out[d + 2] = plte[v * 3 + 2]; out[d + 3] = trns && v < trns.length ? trns[v] : 255; }
      }
    }
  }
  return out;
}
function pngConvert(pix, w, h, ctype, allowGrey) {
  const px = ctype === 6 ? 4 : 3, colors = new Map();
  let opaque = true, grey = true, tooMany = false;
  for (let y = 0; y < h; y++) {
    let s = y * w * px;
    for (let x = 0; x < w; x++, s += px) {
      const r = pix[s], g = pix[s + 1], b = pix[s + 2], a = px === 4 ? pix[s + 3] : 255;
      if (a !== 255) opaque = false;
      if (r !== g || g !== b) grey = false;
      if (!tooMany) {
        const k = ((r * 256 + g) * 256 + b) * 256 + a;
        if (!colors.has(k)) { if (colors.size >= 256) tooMany = true; else colors.set(k, 0); }
      }
    }
  }
  if (!tooMany) {
    const keys = [...colors.keys()].map(k => ({ k, a: k % 256 })).sort((p, q) => (p.a === 255) - (q.a === 255));
    const n = keys.length, depth = n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8;
    keys.forEach((e, i) => colors.set(e.k, i));
    const plte = Buffer.alloc(n * 3);
    let translucent = 0;
    keys.forEach((e, i) => {
      const k = e.k, a = k % 256, b = Math.floor(k / 256) % 256, g = Math.floor(k / 65536) % 256, r = Math.floor(k / 16777216);
      plte[i * 3] = r; plte[i * 3 + 1] = g; plte[i * 3 + 2] = b; if (a !== 255) translucent = i + 1;
    });
    const trns = translucent ? Buffer.from(keys.slice(0, translucent).map(e => e.a)) : null;
    const rb = Math.ceil(w * depth / 8), rows = Buffer.alloc(h * rb);
    for (let y = 0; y < h; y++) {
      let s = y * w * px;
      for (let x = 0; x < w; x++, s += px) {
        const a = px === 4 ? pix[s + 3] : 255, idx = colors.get(((pix[s] * 256 + pix[s + 1]) * 256 + pix[s + 2]) * 256 + a), bit = x * depth;
        rows[y * rb + (bit >> 3)] |= idx << (8 - depth - (bit & 7));
      }
    }
    if (!(depth === 8 && grey && allowGrey && !trns)) return { ctype: 3, depth, rows, plte, trns };
  }
  if (grey && allowGrey) {
    const gp = ctype === 6 && !opaque ? 2 : 1, rows = Buffer.alloc(w * h * gp);
    for (let i = 0, s = 0, d = 0; i < w * h; i++, s += px) { rows[d++] = pix[s]; if (gp === 2) rows[d++] = pix[s + 3]; }
    return { ctype: gp === 2 ? 4 : 0, depth: 8, rows, plte: null, trns: null };
  }
  if (ctype === 6 && opaque) {
    const rows = Buffer.alloc(w * h * 3);
    for (let i = 0, s = 0, d = 0; i < w * h; i++, s += 4) { rows[d++] = pix[s]; rows[d++] = pix[s + 1]; rows[d++] = pix[s + 2]; }
    return { ctype: 2, depth: 8, rows, plte: null, trns: null };
  }
  return null;
}
function pngOptimize(buf) {
  if (buf.length < 57 || !buf.subarray(0, 8).equals(PNG_SIG)) return 'unsupported';
  const chunks = [];
  for (let pos = 8; pos + 12 <= buf.length;) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8);
    if (pos + 12 + len > buf.length) return 'unsupported';
    chunks.push({ type, data: buf.subarray(pos + 8, pos + 8 + len) });
    pos += 12 + len;
    if (type === 'IEND') break;
  }
  if (chunks.length < 3 || chunks[0].type !== 'IHDR' || chunks[chunks.length - 1].type !== 'IEND') return 'unsupported';
  if (chunks.some(c => c.type === 'acTL' || c.type === 'fdAT')) return 'unsupported';   // animated PNG
  const ih = chunks[0].data, w = ih.readUInt32BE(0), h = ih.readUInt32BE(4), depth = ih[8], ctype = ih[9], interlaced = ih[12] !== 0;
  const channels = PNG_CHANNELS[ctype];
  if (!channels || !w || !h || ih[10] || ih[11]) return 'unsupported';
  const bits = channels * depth, rb = Math.ceil(w * bits / 8), st = Math.max(1, bits >> 3);
  if (w * h * channels * depth / 8 > 400 * MB) return 'too big';

  const idats = chunks.filter(c => c.type === 'IDAT');
  if (!idats.length) return 'unsupported';
  let raw;
  try { raw = zlibMod.inflateSync(Buffer.concat(idats.map(c => c.data))); } catch (_) { return 'unsupported'; }
  const origIdat = idats.reduce((n, c) => n + c.data.length, 0);

  const firstIdat = chunks.findIndex(c => c.type === 'IDAT');
  const has = t => chunks.some(c => c.type === t);
  const kept = chunks.map((c, i) => ({ c, i })).filter(({ c }) => !['IHDR', 'IDAT', 'IEND'].includes(c.type) && !PNG_DROP.has(c.type));
  const pre = kept.filter(({ i }) => i < firstIdat).map(({ c }) => c), post = kept.filter(({ i }) => i > firstIdat).map(({ c }) => c);
  const plain = pre.filter(c => c.type !== 'PLTE' && c.type !== 'tRNS');

  const cands = [];
  let pix = null;
  if (!interlaced) {
    if (raw.length !== h * (rb + 1)) return 'unsupported';
    pix = unfilterPng(raw, h, rb, st);
    if (!pix) return 'unsupported';
  }
  const rawSets = [{ tag: 'orig', data: raw }];
  if (pix && raw.length <= 96 * MB) {
    rawSets.push({ tag: 'adaptive', data: refilterPng(pix, h, rb, st) });
    if (ctype === 3 || depth < 8) rawSets.push({ tag: 'none', data: noFilterPng(pix, h, rb) });
  }
  const bestSame = smallestDeflate(rawSets);
  cands.push({ z: bestSame.z, ctype, depth, plte: null, trns: null, same: true, pix, raw: bestSame.data });
  cands.push({ z: Buffer.concat(idats.map(c => c.data)), ctype, depth, plte: null, trns: null, same: true, pix, raw });

  const tied = ['bKGD', 'hIST', 'sBIT', 'sPLT'].some(has) || (ctype === 2 && has('tRNS'));
  if (pix && depth === 8 && (ctype === 2 || ctype === 6) && !tied && w * h <= 64e6) {
    const cv = pngConvert(pix, w, h, ctype, !has('iCCP'));
    if (cv) {
      const nrb = Math.ceil(w * PNG_CHANNELS[cv.ctype] * cv.depth / 8);
      const sets = [{ tag: 'adaptive', data: refilterPng(cv.rows, h, nrb, Math.max(1, (PNG_CHANNELS[cv.ctype] * cv.depth) >> 3)) }];
      if (cv.ctype === 3 || cv.depth < 8) sets.push({ tag: 'none', data: noFilterPng(cv.rows, h, nrb) });
      const b = smallestDeflate(sets);
      cands.push({ z: b.z, ctype: cv.ctype, depth: cv.depth, plte: cv.plte, trns: cv.trns, same: false, pix: cv.rows, raw: b.data, nrb });
    }
  }
  cands.sort((a, b) => a.z.length - b.z.length);
  const win = cands[0];

  if (win.same) {
    if (pix) { const back = unfilterPng(zlibMod.inflateSync(win.z), h, rb, st); if (!back || !back.equals(pix)) return 'unsupported'; }
    else if (!zlibMod.inflateSync(win.z).equals(raw)) return 'unsupported';
  } else {
    const back = unfilterPng(zlibMod.inflateSync(win.z), h, win.nrb, Math.max(1, (PNG_CHANNELS[win.ctype] * win.depth) >> 3));
    const a = pngToRgba(ctype, 8, pix, w, h, null, null);
    const b = back && pngToRgba(win.ctype, win.depth, back, w, h, win.plte, win.trns);
    if (!b || !a.equals(b)) return 'unsupported';
  }

  const head = Buffer.from(ih);
  if (!win.same) { head[8] = win.depth; head[9] = win.ctype; }
  const parts = [PNG_SIG, pngChunk('IHDR', head)];
  if (win.same) { for (const c of pre) parts.push(pngChunk(c.type, c.data)); }
  else {
    for (const c of plain) parts.push(pngChunk(c.type, c.data));
    if (win.plte) { parts.push(pngChunk('PLTE', win.plte)); if (win.trns) parts.push(pngChunk('tRNS', win.trns)); }
  }
  parts.push(pngChunk('IDAT', win.z));
  for (const c of post) parts.push(pngChunk(c.type, c.data));
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  const outBuf = Buffer.concat(parts);
  return outBuf.length < buf.length ? outBuf : 'not smaller';
}

const JPEG_DROP_APP = new Set([0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xEB, 0xEC, 0xED, 0xEF]);
function jpegKeepSegment(m, body) {
  if (m === 0xFE) return false;
  if (JPEG_DROP_APP.has(m)) return false;
  if (m === 0xE1) return !body.subarray(0, 29).toString('latin1').startsWith('http://ns.adobe.com/xap/');
  if (m === 0xE2) return body.subarray(0, 12).toString('latin1') === 'ICC_PROFILE\0';
  return true;
}
function buildHuffDecoder(bits, vals) {
  const look = new Uint16Array(65536);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++, k++, code++) {
      const lo = code << (16 - len), hi = (code + 1) << (16 - len);
      if (hi > 65536) throw new Error('bad table');
      look.fill((len << 8) | vals[k], lo, hi);
    }
    code <<= 1;
  }
  return look;
}
function jpegDecodeScan(buf, start, frame, ri, sc, decoders) {
  const nSc = sc.comps.length, ev = { a: new Uint32Array(1 << 16), n: 0 };
  const push = v => { if (ev.n === ev.a.length) { const t = new Uint32Array(ev.a.length * 2); t.set(ev.a); ev.a = t; } ev.a[ev.n++] = v; };
  let pos = start, bb = 0, bc = 0, fake = 0, hit = false;
  const fill = () => {
    while (bc <= 24) {
      let byte = 0;
      if (!hit && pos < buf.length) {
        byte = buf[pos];
        if (byte === 0xFF) { if (buf[pos + 1] === 0) pos += 2; else { hit = true; byte = 0; fake += 8; } } else pos++;
      } else fake += 8;
      bb = (bb << 8) | byte; bc += 8;
    }
  };
  const hmax = Math.max(...frame.comps.map(c => c.h)), vmax = Math.max(...frame.comps.map(c => c.v));
  let blocks = [], total;
  if (nSc > 1) {
    for (const c of sc.comps) for (let i = 0; i < c.h * c.v; i++) blocks.push(c);
    total = Math.ceil(frame.w / (8 * hmax)) * Math.ceil(frame.h / (8 * vmax));
  } else {
    const c = sc.comps[0];
    blocks = [c];
    total = Math.ceil(Math.ceil(frame.w * c.h / hmax) / 8) * Math.ceil(Math.ceil(frame.h * c.v / vmax) / 8);
  }
  const sym = (look) => {
    if (bc < 16) fill();
    const e = look[(bb >>> (bc - 16)) & 0xFFFF];
    if (!e) throw new Error('bad code');
    bc -= e >> 8; return e & 255;
  };
  const bitsOf = (n) => { if (bc < 16) fill(); const v = (bb >>> (bc - n)) & ((1 << n) - 1); bc -= n; return v; };
  const checkEnd = () => {
    if (bc < fake || bc - fake >= 8) throw new Error('trailing data');
    if (!(buf[pos] === 0xFF && pos + 1 < buf.length && buf[pos + 1] !== 0)) throw new Error('not at marker');
  };
  let rst = 0;
  for (let m = 0; m < total; m++) {
    for (const c of blocks) {
      const dt = c.td, at = 4 + c.ta;
      const s = sym(decoders[dt]);
      if (s > 11) throw new Error('bad dc');
      push((dt << 23) | (s << 15) | (s << 11) | (s ? bitsOf(s) : 0));
      for (let k = 1; k < 64;) {
        const rs = sym(decoders[at]), r = rs >> 4, z = rs & 15;
        if (z === 0) {
          push((at << 23) | (rs << 15));
          if (r === 15) { k += 16; continue; }
          break;
        }
        if (z > 10) throw new Error('bad ac');
        k += r; if (k > 63) throw new Error('bad run');
        push((at << 23) | (rs << 15) | (z << 11) | bitsOf(z));
        k++;
      }
    }
    if (ri && (m + 1) % ri === 0 && m + 1 < total) {
      checkEnd();
      if (buf[pos + 1] !== 0xD0 + (rst & 7)) throw new Error('missing restart');
      pos += 2; rst++; bb = 0; bc = 0; fake = 0; hit = false;
      push(15 << 23);
    }
  }
  checkEnd();
  return { events: ev.a.subarray(0, ev.n), end: pos };
}
function optimalHuffman(freqIn) {
  const freq = new Float64Array(257); for (let i = 0; i < 256; i++) freq[i] = freqIn[i]; freq[256] = 1;
  const size = new Int32Array(257), others = new Int32Array(257).fill(-1);
  for (;;) {
    let c1 = -1, v = Infinity;
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v) { v = freq[i]; c1 = i; }
    let c2 = -1; v = Infinity;
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v && i !== c1) { v = freq[i]; c2 = i; }
    if (c2 < 0) break;
    freq[c1] += freq[c2]; freq[c2] = 0;
    size[c1]++; while (others[c1] >= 0) { c1 = others[c1]; size[c1]++; }
    others[c1] = c2;
    size[c2]++; while (others[c2] >= 0) { c2 = others[c2]; size[c2]++; }
  }
  const bits = new Int32Array(64);
  for (let i = 0; i <= 256; i++) if (size[i]) { if (size[i] > 62) throw new Error('code too long'); bits[size[i]]++; }
  for (let i = 62; i > 16; i--) {
    while (bits[i] > 0) { let j = i - 2; while (bits[j] === 0) j--; bits[i] -= 2; bits[i - 1]++; bits[j + 1] += 2; bits[j]--; }
  }
  let i = 16; while (bits[i] === 0) i--; bits[i]--;
  const vals = [];
  for (let len = 1; len <= 62; len++) for (let s = 0; s < 256; s++) if (size[s] === len) vals.push(s);
  return { bits: Buffer.from(Array.from(bits.subarray(1, 17))), vals: Buffer.from(vals) };
}
function parseJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) throw new Error('not jpeg');
  let pos = 2, frame = null, ri = 0, sawScan = false, sawEoi = false;
  const items = [], tables = {}, decoders = {};
  while (pos < buf.length) {
    if (buf[pos] !== 0xFF) throw new Error('bad marker');
    while (buf[pos + 1] === 0xFF) pos++;
    const m = buf[pos + 1];
    if (m === 0xD9) { pos += 2; sawEoi = true; break; }
    if (m === 0x00 || m === 0x01 || (m >= 0xD0 && m <= 0xD8)) throw new Error('unexpected marker');
    const len = buf.readUInt16BE(pos + 2), end = pos + 2 + len;
    if (len < 2 || end > buf.length) throw new Error('bad length');
    const body = buf.subarray(pos + 4, end);
    if (m === 0xC4) {
      for (let o = 0; o < body.length;) {
        const cls = body[o] >> 4, id = body[o] & 15;
        if (cls > 1 || id > 3) throw new Error('bad dht');
        const bits = body.subarray(o + 1, o + 17); let n = 0; for (const b of bits) n += b;
        const vals = body.subarray(o + 17, o + 17 + n);
        if (n > 256 || vals.length !== n) throw new Error('bad dht');
        const key = cls * 4 + id;
        if (sawScan && tables[key] && !(tables[key].bits.equals(bits) && tables[key].vals.equals(vals))) throw new Error('tables change between scans');
        if (sawScan && !tables[key]) throw new Error('new table after scan');
        tables[key] = { bits: Buffer.from(bits), vals: Buffer.from(vals) }; decoders[key] = null;
        o += 17 + n;
      }
    } else if (m === 0xC0 || m === 0xC1) {
      if (frame || body[0] !== 8) throw new Error('unsupported frame');
      frame = { h: body.readUInt16BE(1), w: body.readUInt16BE(3), comps: [] };
      for (let i = 0; i < body[5]; i++) frame.comps.push({ id: body[6 + i * 3], h: body[7 + i * 3] >> 4, v: body[7 + i * 3] & 15 });
      if (!frame.h || !frame.w || !frame.comps.length || frame.comps.some(c => !c.h || !c.v)) throw new Error('bad frame');
      items.push({ raw: buf.subarray(pos, end) });
    } else if (m >= 0xC2 && m <= 0xCF) {
      throw new Error('not baseline');
    } else if (m === 0xDC) {
      throw new Error('DNL');
    } else if (m === 0xDD) {
      ri = body.readUInt16BE(0); items.push({ raw: buf.subarray(pos, end) });
    } else if (m === 0xDA) {
      if (!frame) throw new Error('scan before frame');
      const ns = body[0], comps = [];
      for (let i = 0; i < ns; i++) {
        const fc = frame.comps.find(c => c.id === body[1 + i * 2]);
        if (!fc) throw new Error('bad scan component');
        comps.push({ h: fc.h, v: fc.v, td: body[2 + i * 2] >> 4, ta: body[2 + i * 2] & 15 });
      }
      if (body[1 + ns * 2] !== 0 || body[2 + ns * 2] !== 63 || body[3 + ns * 2] !== 0) throw new Error('not sequential');
      for (const c of comps) {
        if (c.td > 3 || c.ta > 3 || !tables[c.td] || !tables[4 + c.ta]) throw new Error('missing table');
        for (const k of [c.td, 4 + c.ta]) if (!decoders[k]) decoders[k] = buildHuffDecoder(tables[k].bits, tables[k].vals);
      }
      const r = jpegDecodeScan(buf, end, frame, ri, { comps }, decoders);
      items.push({ scan: true, hdr: buf.subarray(pos, end), events: r.events });
      sawScan = true; pos = r.end; continue;
    } else if (jpegKeepSegment(m, body)) {
      items.push({ raw: buf.subarray(pos, end) });
    }
    pos = end;
  }
  if (!sawEoi || !sawScan) throw new Error('incomplete');
  if (pos !== buf.length) throw new Error('data after the end');
  return { items, tables };
}
function jpegOptimize(buf) {
  let p;
  try { p = parseJpeg(buf); } catch (_) { return 'unsupported'; }
  const freq = Array.from({ length: 8 }, () => new Float64Array(256));
  for (const it of p.items) if (it.scan) for (const v of it.events) { const t = v >>> 23; if (t < 8) freq[t][(v >>> 15) & 255]++; }
  const codes = {}, dht = [];
  for (let slot = 0; slot < 8; slot++) {
    if (!freq[slot].some(Boolean)) continue;
    const orig = p.tables[slot];
    if (!orig) return 'unsupported';
    let t;
    try { t = optimalHuffman(freq[slot]); } catch (_) { return 'unsupported'; }
    const code = new Uint16Array(256), len = new Uint8Array(256);
    let c = 0, k = 0;
    for (let l = 1; l <= 16; l++) { for (let i = 0; i < t.bits[l - 1]; i++, k++, c++) { code[t.vals[k]] = c; len[t.vals[k]] = l; } c <<= 1; }
    for (let s = 0; s < 256; s++) if (freq[slot][s] && !len[s]) return 'unsupported';
    codes[slot] = { code, len };
    dht.push(Buffer.concat([Buffer.from([(slot < 4 ? 0 : 0x10) | (slot & 3)]), t.bits, t.vals]));
  }
  const dhtBody = Buffer.concat(dht), dhtSeg = Buffer.alloc(4); dhtSeg[0] = 0xFF; dhtSeg[1] = 0xC4; dhtSeg.writeUInt16BE(dhtBody.length + 2, 2);

  let out = Buffer.allocUnsafe(buf.length + 65536), n = 0, acc = 0, nb = 0;
  const room = k => { if (n + k > out.length) { const t = Buffer.allocUnsafe(out.length * 2 + k); out.copy(t, 0, 0, n); out = t; } };
  const put = b => { room(1); out[n++] = b; };
  const write = (code, len) => {
    acc = (acc << len) | code; nb += len;
    while (nb >= 8) { const byte = (acc >>> (nb - 8)) & 255; put(byte); if (byte === 255) put(0); nb -= 8; }
    acc &= (1 << nb) - 1;
  };
  const flushBits = () => { if (nb) write((1 << (8 - nb)) - 1, 8 - nb); };
  const copy = b => { room(b.length); b.copy(out, n); n += b.length; };
  put(0xFF); put(0xD8);
  let wroteDht = false;
  for (const it of p.items) {
    if (it.raw) { copy(it.raw); continue; }
    if (!wroteDht) { copy(dhtSeg); copy(dhtBody); wroteDht = true; }
    copy(it.hdr);
    let rst = 0;
    for (const v of it.events) {
      const t = v >>> 23;
      if (t === 15) { flushBits(); put(0xFF); put(0xD0 + (rst++ & 7)); continue; }
      const s = (v >>> 15) & 255, nbits = (v >>> 11) & 15, cd = codes[t];
      write(cd.code[s], cd.len[s]);
      if (nbits) write(v & ((1 << nbits) - 1), nbits);
    }
    flushBits();
  }
  put(0xFF); put(0xD9);
  const res = out.subarray(0, n);
  if (res.length >= buf.length) return 'not smaller';
  try {
    const back = parseJpeg(res), a = p.items.filter(i => i.scan), b = back.items.filter(i => i.scan);
    if (a.length !== b.length) return 'unsupported';
    for (let i = 0; i < a.length; i++) {
      if (a[i].events.length !== b[i].events.length) return 'unsupported';
      for (let j = 0; j < a[i].events.length; j++) if (a[i].events[j] !== b[i].events[j]) return 'unsupported';
    }
  } catch (_) { return 'unsupported'; }
  return Buffer.from(res);
}
function ffmpegPictureHash(file) {
  return new Promise(resolve => {
    let out = '';
    const p = spawn(ffmpegBin(), ['-v', 'error', '-nostdin', '-i', file, '-map', '0:v:0', '-pix_fmt', 'rgba', '-f', 'md5', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', code => resolve(code === 0 ? out.trim() : null));
  });
}
async function losslessPicture(job, outPath) {
  const size = fs.statSync(job.inPath).size;
  if (size > 300 * MB) return { ok: false, reason: 'too big' };
  const input = fs.readFileSync(job.inPath);
  const res = job.ext === 'png' ? pngOptimize(input) : jpegOptimize(input);
  if (typeof res === 'string') return { ok: false, reason: res };
  fs.writeFileSync(outPath, res);
  if (await available()) {
    const [a, b] = await Promise.all([ffmpegPictureHash(job.inPath), ffmpegPictureHash(outPath)]);
    if (a && a !== b) return { ok: false, reason: 'unsupported' };
  }
  if (job.onProgress) job.onProgress(100);
  return { ok: true, size: res.length };
}

async function compress(job) {
  if (job.lossless && LOSSLESS_NATIVE.has(job.ext)) {
    fs.mkdirSync(job.tmpDir, { recursive: true });
    const outPath = path.join(job.tmpDir, job.outName);
    let r;
    try { r = await losslessPicture(job, outPath); } catch (e) { r = { ok: false, reason: String((e && e.message) || e).slice(0, 200) }; }
    if (!r.ok) { try { fs.unlinkSync(outPath); } catch (_) { /* ignore */ } return r; }
    return { ok: true, path: outPath, size: r.size };
  }
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

module.exports = { NATIVE, LOSSLESS_NATIVE, VIDEO, AUDIO, IMAGE, available, compress, cancelAll, ffmpegBin, tmpRoot: () => path.join(os.tmpdir(), 'squeeze-' + process.pid) };
