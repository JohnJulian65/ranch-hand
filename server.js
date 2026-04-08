require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const { Resend } = require('resend');
const initSqlJs = require('sql.js');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize SQLite database
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const DB_PATH = path.join(dataDir, 'tasks.db');
let db;

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      assigned_to TEXT DEFAULT '',
      assigned_email TEXT DEFAULT '',
      due_date TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  saveDb();
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function dbAll(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbGet(sql, params) {
  const rows = dbAll(sql, params);
  return rows[0] || null;
}

function dbRun(sql, params) {
  db.run(sql, params);
  saveDb();
}

// Member email directory
const MEMBER_EMAILS = {
  'Grant': '',
  'Patrick': '',
  'Aaron': '',
  'Cesar': 'cdager12@gmail.com',
  'Jon Michael': '',
  'Julian': 'johnjvandaeleiii@gmail.com',
};

const FROM_ADDRESS = process.env.RESEND_FROM || 'onboarding@resend.dev';

// Load all context files as system prompt
const contextDir = path.join(__dirname, 'context');
const systemPrompt = fs.readdirSync(contextDir)
  .filter(f => f.endsWith('.md'))
  .sort()
  .map(f => fs.readFileSync(path.join(contextDir, f), 'utf-8'))
  .join('\n\n---\n\n');

const client = new Anthropic();

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages,
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('Anthropic API error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to get response from Claude' });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

app.post('/api/send-email', async (req, res) => {
  const { assignee, task, dueDate, assignedBy } = req.body;

  if (!assignee || !task) {
    return res.status(400).json({ error: 'assignee and task are required' });
  }

  const email = MEMBER_EMAILS[assignee];
  if (!email) {
    return res.json({ sent: false, reason: 'No email on file for ' + assignee });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'RESEND_API_KEY is not configured' });
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({
      from: FROM_ADDRESS,
      to: email,
      subject: 'Ranch Hand — New Task Assigned to You',
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:500px;margin:0 auto;padding:20px;">
          <h2 style="color:#2C2C2C;margin-bottom:4px;">New Task Assigned</h2>
          <p style="color:#888;font-size:14px;margin-top:0;">From Ranch Hand / Capitol Cowboys Operations</p>
          <hr style="border:none;border-top:2px solid #C9A84C;margin:16px 0;">
          <p><strong>Task:</strong> ${task}</p>
          <p><strong>Assigned To:</strong> ${assignee}</p>
          ${dueDate ? `<p><strong>Due Date:</strong> ${dueDate}</p>` : ''}
          ${assignedBy ? `<p><strong>Assigned By:</strong> ${assignedBy}</p>` : ''}
          <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
          <p style="color:#999;font-size:12px;">This notification was sent by Ranch Hand, the AI operations assistant for Capitol Cowboys LLC.</p>
        </div>
      `,
    });

    console.log('Resend response:', JSON.stringify(result));
    res.json({ sent: true, result });
  } catch (err) {
    console.error('Email send error:', err.message);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// ── Task API ──

app.get('/api/tasks', (req, res) => {
  const tasks = dbAll('SELECT * FROM tasks ORDER BY created_at DESC');
  res.json(tasks);
});

app.post('/api/tasks', (req, res) => {
  const { title, description, assigned_to, due_date, status } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  const assignedEmail = MEMBER_EMAILS[assigned_to] || '';
  dbRun(
    `INSERT INTO tasks (title, description, assigned_to, assigned_email, due_date, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [title, description || '', assigned_to || '', assignedEmail, due_date || '', status || 'pending']
  );

  const task = dbGet('SELECT * FROM tasks WHERE id = last_insert_rowid()');
  res.json(task);
});

app.patch('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const { title, description, assigned_to, due_date, status } = req.body;

  const existing = dbGet('SELECT * FROM tasks WHERE id = ?', [Number(id)]);
  if (!existing) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const assignedEmail = assigned_to !== undefined
    ? (MEMBER_EMAILS[assigned_to] || '')
    : existing.assigned_email;

  dbRun(
    `UPDATE tasks SET title = ?, description = ?, assigned_to = ?, assigned_email = ?, due_date = ?, status = ? WHERE id = ?`,
    [
      title !== undefined ? title : existing.title,
      description !== undefined ? description : existing.description,
      assigned_to !== undefined ? assigned_to : existing.assigned_to,
      assignedEmail,
      due_date !== undefined ? due_date : existing.due_date,
      status !== undefined ? status : existing.status,
      Number(id)
    ]
  );

  const updated = dbGet('SELECT * FROM tasks WHERE id = ?', [Number(id)]);
  res.json(updated);
});

app.delete('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const existing = dbGet('SELECT * FROM tasks WHERE id = ?', [Number(id)]);
  if (!existing) {
    return res.status(404).json({ error: 'Task not found' });
  }
  dbRun('DELETE FROM tasks WHERE id = ?', [Number(id)]);
  res.json({ deleted: true });
});

// ── Automated Task Reminders (daily at 9 AM ET) ──

async function sendReminderEmail(task, type) {
  if (!task.assigned_email || !process.env.RESEND_API_KEY) return;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const isOverdue = type === 'overdue';

  const subject = isOverdue
    ? `Ranch Hand — OVERDUE: ${task.title}`
    : `Ranch Hand — Reminder: ${task.title} is due soon`;

  const heading = isOverdue
    ? 'This task is overdue.'
    : 'Heads up — this task is coming up.';

  const tone = isOverdue
    ? 'This needed to be done already. Get it across the finish line today.'
    : 'You\'ve got less than 48 hours. Make sure this gets handled.';

  const accentColor = isOverdue ? '#c0392b' : '#C9A84C';

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: task.assigned_email,
      subject,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:500px;margin:0 auto;padding:20px;">
          <h2 style="color:${accentColor};margin-bottom:4px;">${heading}</h2>
          <p style="color:#888;font-size:14px;margin-top:0;">Ranch Hand / Capitol Cowboys Operations</p>
          <hr style="border:none;border-top:2px solid ${accentColor};margin:16px 0;">
          <p><strong>Task:</strong> ${task.title}</p>
          ${task.description ? `<p><strong>Details:</strong> ${task.description}</p>` : ''}
          <p><strong>Assigned To:</strong> ${task.assigned_to}</p>
          <p><strong>Due Date:</strong> ${task.due_date}</p>
          <p style="margin-top:16px;color:#333;">${tone}</p>
          <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
          <p style="color:#999;font-size:12px;">— Ranch Hand, Capitol Cowboys Operations Assistant</p>
        </div>
      `,
    });
    console.log(`[Reminder] ${type} email sent to ${task.assigned_email} for: ${task.title}`);
  } catch (err) {
    console.error(`[Reminder] Failed to send ${type} email to ${task.assigned_email}:`, err.message);
  }
}

function runDailyReminders() {
  console.log('[Reminder] Running daily task check...');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];

  const twoDaysOut = new Date(today);
  twoDaysOut.setDate(twoDaysOut.getDate() + 2);
  const twoDaysStr = twoDaysOut.toISOString().split('T')[0];

  // Tasks due within 48 hours that are still pending or in-progress
  const upcoming = dbAll(
    `SELECT * FROM tasks WHERE due_date != '' AND due_date >= ? AND due_date <= ? AND status IN ('pending', 'in-progress') AND assigned_email != ''`,
    [todayStr, twoDaysStr]
  );

  // Tasks that are overdue (past due date, not done)
  const overdue = dbAll(
    `SELECT * FROM tasks WHERE due_date != '' AND due_date < ? AND status IN ('pending', 'in-progress') AND assigned_email != ''`,
    [todayStr]
  );

  console.log(`[Reminder] Found ${upcoming.length} upcoming, ${overdue.length} overdue tasks`);

  upcoming.forEach(task => sendReminderEmail(task, 'upcoming'));
  overdue.forEach(task => sendReminderEmail(task, 'overdue'));
}

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Ranch Hand running on http://localhost:${PORT}`);
  });

  // Run daily at 9:00 AM (server time)
  cron.schedule('0 9 * * *', () => {
    runDailyReminders();
  });
  console.log('[Reminder] Daily reminder cron scheduled for 9:00 AM');
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
