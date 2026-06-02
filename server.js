const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3456;
const DATA_DIR = path.join(__dirname, 'data');
const SECRET = 'our-little-secret-2025';

app.use(cors());
app.use(express.json());

// ── Serve frontend ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ──
function auth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (token !== SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

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
}

// ── Health check (no auth needed) ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Start ──
seedIfEmpty();
app.listen(PORT, () => {
  console.log(`🕯️  LO & 小鲸鱼 情侣空间已开启`);
  console.log(`   主页: http://localhost:${PORT}`);
  console.log(`   API:  http://localhost:${PORT}/api/health`);
});
