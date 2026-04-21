require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const sgMail = require('@sendgrid/mail');
const cron = require('node-cron');
const cheerio = require('cheerio');

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const app = express();
const PORT = process.env.PORT || 3000;

const DEFAULT_PIN = '1234';
const BCRYPT_ROUNDS = 10;
const isBcryptHash = (s) => typeof s === 'string' && /^\$2[aby]\$/.test(s);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize database — Turso in production, sql.js locally
let dbAll, dbGet, dbRun;

async function initDb() {
  const CREATE_TASKS_TABLE = `
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
  `;

  const CREATE_MEMORY_TABLE = `
    CREATE TABLE IF NOT EXISTS conversation_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `;

  const CREATE_USERS_TABLE = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      pin TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `;

  const CREATE_EVENTS_TABLE = `
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      event_name TEXT DEFAULT '',
      event_date TEXT DEFAULT '',
      total_guests INTEGER DEFAULT 0,
      plus_ones INTEGER DEFAULT 0,
      approved INTEGER DEFAULT 0,
      maybe INTEGER DEFAULT 0,
      declined INTEGER DEFAULT 0,
      waitlist INTEGER DEFAULT 0,
      last_synced TEXT DEFAULT (datetime('now'))
    )
  `;

  const CREATE_EVENT_GUESTS_TABLE = `
    CREATE TABLE IF NOT EXISTS event_guests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      guest_name TEXT DEFAULT '',
      status TEXT DEFAULT '',
      plus_one_count INTEGER DEFAULT 0,
      rsvp_date TEXT DEFAULT '',
      last_synced TEXT DEFAULT (datetime('now'))
    )
  `;

  if (process.env.TURSO_DATABASE_URL) {
    // Production: Turso (libsql over HTTP)
    const { createClient } = require('@libsql/client/web');
    const db = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });

    dbAll = async (sql, params) => {
      const result = await db.execute({ sql, args: params || [] });
      return result.rows;
    };
    dbGet = async (sql, params) => {
      const rows = await dbAll(sql, params);
      return rows[0] || null;
    };
    dbRun = async (sql, params) => {
      return await db.execute({ sql, args: params || [] });
    };

    await db.execute(CREATE_TASKS_TABLE);
    await db.execute(CREATE_MEMORY_TABLE);
    await db.execute(CREATE_USERS_TABLE);
    await db.execute(CREATE_EVENTS_TABLE);
    await db.execute(CREATE_EVENT_GUESTS_TABLE);
    const defaultPinHashTurso = await bcrypt.hash(DEFAULT_PIN, BCRYPT_ROUNDS);
    for (const [name, email] of Object.entries(MEMBER_EMAILS)) {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO users (name, pin, email) VALUES (?, ?, ?)',
        args: [name, defaultPinHashTurso, email],
      });
    }
    console.log('[DB] Connected to Turso');
  } else {
    // Local dev: sql.js (in-memory with file persistence)
    const initSqlJs = require('sql.js');
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
    const DB_PATH = path.join(dataDir, 'tasks.db');

    const SQL = await initSqlJs();
    let sqlDb;
    if (fs.existsSync(DB_PATH)) {
      sqlDb = new SQL.Database(fs.readFileSync(DB_PATH));
    } else {
      sqlDb = new SQL.Database();
    }

    const saveDb = () => fs.writeFileSync(DB_PATH, Buffer.from(sqlDb.export()));

    dbAll = async (sql, params) => {
      const stmt = sqlDb.prepare(sql);
      if (params) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    };
    dbGet = async (sql, params) => {
      const rows = await dbAll(sql, params);
      return rows[0] || null;
    };
    dbRun = async (sql, params) => {
      sqlDb.run(sql, params);
      saveDb();
      return { lastInsertRowid: sqlDb.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] };
    };

    sqlDb.run(CREATE_TASKS_TABLE);
    sqlDb.run(CREATE_MEMORY_TABLE);
    sqlDb.run(CREATE_USERS_TABLE);
    sqlDb.run(CREATE_EVENTS_TABLE);
    sqlDb.run(CREATE_EVENT_GUESTS_TABLE);
    const defaultPinHashLocal = await bcrypt.hash(DEFAULT_PIN, BCRYPT_ROUNDS);
    for (const [name, email] of Object.entries(MEMBER_EMAILS)) {
      sqlDb.run(
        'INSERT OR IGNORE INTO users (name, pin, email) VALUES (?, ?, ?)',
        [name, defaultPinHashLocal, email]
      );
    }
    saveDb();
    console.log('[DB] Using local sql.js at', DB_PATH);
  }

  // Migration: hash any PINs left over from the plaintext era.
  // Runs once — idempotent, detected by the $2a/$2b/$2y bcrypt prefix.
  const rows = await dbAll('SELECT id, pin FROM users');
  for (const row of rows) {
    const pin = row.pin == null ? '' : String(row.pin);
    if (pin && !isBcryptHash(pin)) {
      const hashed = await bcrypt.hash(pin, BCRYPT_ROUNDS);
      await dbRun('UPDATE users SET pin = ? WHERE id = ?', [hashed, row.id]);
      console.log(`[Auth] Hashed legacy PIN for user id=${row.id}`);
    }
  }
}

// Member email directory
const MEMBER_EMAILS = {
  'Julian': 'johnjvandaeleiii@gmail.com',
  'Cesar': 'cdager12@gmail.com',
  'Jon Michael': 'Jonmichaelraasch@gmail.com',
  'Grant': 'grantgoerke@gmail.com',
  'Nico': 'Numetin12@gmail.com',
  'Patrick': 'patrickwortmann21@gmail.com',
  'Tristan': 'tristanshakespeare@gmail.com',
  'Aaron': 'aargeo17@gmail.com',
  'Ryan': 'ryanbraithwaite11@gmail.com',
};

const ALL_MEMBER_NAMES = Object.keys(MEMBER_EMAILS);

// Normalize an assigned_to input (string, comma-separated string, or array) to a clean array of member names.
// "All Members" (anywhere in the input) expands to every member.
function parseAssignees(input) {
  if (input == null) return [];
  const raw = Array.isArray(input) ? input : String(input).split(',');
  const list = raw.map(s => String(s).trim()).filter(Boolean);
  if (list.some(n => n.toLowerCase() === 'all members')) return ALL_MEMBER_NAMES.slice();
  return list;
}

function emailsForAssignees(names) {
  return names.map(n => MEMBER_EMAILS[n]).filter(Boolean);
}

const FROM_ADDRESS = process.env.EMAIL_FROM || 'onboarding@example.com';

// Load all context files as system prompt
const contextDir = path.join(__dirname, 'context');
const systemPrompt = fs.readdirSync(contextDir)
  .filter(f => f.endsWith('.md'))
  .sort()
  .map(f => fs.readFileSync(path.join(contextDir, f), 'utf-8'))
  .join('\n\n---\n\n');

const client = new Anthropic();

async function summarizeAndSave(sessionId, userMessage, assistantResponse) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `Summarize this conversation exchange in 1-2 concise sentences. Focus on the key topic, any decisions made, and any action items. Do not include any preamble — just the summary.\n\nUser: ${userMessage}\n\nAssistant: ${assistantResponse.slice(0, 2000)}`
    }],
  });

  const summary = response.content[0].text.trim();
  await dbRun(
    `INSERT INTO conversation_memory (session_id, summary) VALUES (?, ?)`,
    [sessionId, summary]
  );
  console.log(`[Memory] Saved summary for session ${sessionId.slice(0, 8)}...`);
}

const SEXIEST_COWBOY_RESPONSE = "Well Julian is obviously as he has the biggest muscles and straightest jaw line. Cesar is close but his personal hygeine gets in the way.Tristan is third, Grant is fourth and Aaron wasn't accepted in the competition";
const SEXIEST_COWBOY_PATTERN = /sexiest\s+cowboy/i;

app.post('/api/chat', async (req, res) => {
  const { messages, session_id } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  // Easter egg — short-circuit before the model call so the exact wording
  // is guaranteed. Leaves memory and task parsing untouched.
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  if (lastUserMessage && SEXIEST_COWBOY_PATTERN.test(String(lastUserMessage.content || ''))) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const chunks = SEXIEST_COWBOY_RESPONSE.match(/.{1,6}/g) || [SEXIEST_COWBOY_RESPONSE];
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      await new Promise(r => setTimeout(r, 18));
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // Build system prompt with conversation memory
  let fullSystemPrompt = systemPrompt;
  if (session_id) {
    try {
      const memories = await dbAll(
        `SELECT * FROM conversation_memory WHERE session_id = ? ORDER BY created_at DESC LIMIT 5`,
        [session_id]
      );
      if (memories.length > 0) {
        const memoryBlock = memories.reverse().map(m => `- ${m.summary}`).join('\n');
        fullSystemPrompt += `\n\n---\n\n## Conversation Memory\nHere are summaries of recent past conversations with this user. Use this context to provide continuity and remember what was previously discussed:\n${memoryBlock}`;
      }
    } catch (err) {
      console.error('[Memory] Failed to load memory:', err.message);
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: fullSystemPrompt,
      messages: messages,
    });

    let fullResponse = '';

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        fullResponse += event.delta.text;
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    // Parse and create tasks from ```tasks JSON blocks
    const tasksMatch = fullResponse.match(/```tasks\s*\n([\s\S]*?)```/);
    if (tasksMatch) {
      try {
        const taskList = JSON.parse(tasksMatch[1]);
        const created = [];
        for (const t of taskList) {
          if (!t.title) continue;
          const names = parseAssignees(t.assigned_to);
          const assignedToStr = names.join(', ');
          const assignedEmailStr = emailsForAssignees(names).join(',');
          await dbRun(
            `INSERT INTO tasks (title, description, assigned_to, assigned_email, due_date, status)
             VALUES (?, ?, ?, ?, ?, 'pending')`,
            [t.title, t.description || '', assignedToStr, assignedEmailStr, t.due_date || '']
          );
          created.push({ title: t.title, assigned_to: assignedToStr, assigned_email: assignedEmailStr });
        }
        if (created.length > 0) {
          console.log(`[Meeting] Created ${created.length} tasks from transcript`);
          res.write(`data: ${JSON.stringify({ tasksCreated: created })}\n\n`);
        }
      } catch (parseErr) {
        console.error('[Meeting] Failed to parse tasks JSON:', parseErr.message);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();

    // Async: summarize and save conversation memory
    if (session_id && fullResponse) {
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      if (lastUserMsg) {
        summarizeAndSave(session_id, lastUserMsg.content, fullResponse).catch(err =>
          console.error('[Memory] Summary failed:', err.message)
        );
      }
    }
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

app.post('/api/login', async (req, res) => {
  const { name, pin } = req.body || {};
  if (!name || !pin) {
    return res.status(400).json({ error: 'name and pin are required' });
  }
  const user = await dbGet(
    'SELECT id, name, email, pin FROM users WHERE name = ?',
    [String(name)]
  );
  if (!user || !(await bcrypt.compare(String(pin), user.pin))) {
    return res.status(401).json({ error: 'Invalid name or PIN' });
  }
  const mustChangePin = await bcrypt.compare(DEFAULT_PIN, user.pin);
  res.json({ name: user.name, email: user.email, mustChangePin });
});

app.post('/api/change-pin', async (req, res) => {
  const { name, currentPin, newPin } = req.body || {};
  if (!name || !currentPin || !newPin) {
    return res.status(400).json({ error: 'name, currentPin, and newPin are required' });
  }
  if (!/^\d{4}$/.test(String(newPin))) {
    return res.status(400).json({ error: 'New PIN must be exactly 4 digits' });
  }
  if (String(newPin) === DEFAULT_PIN) {
    return res.status(400).json({ error: 'New PIN cannot be 1234' });
  }
  if (String(newPin) === String(currentPin)) {
    return res.status(400).json({ error: 'New PIN must differ from current PIN' });
  }
  const user = await dbGet('SELECT id, pin FROM users WHERE name = ?', [String(name)]);
  if (!user || !(await bcrypt.compare(String(currentPin), user.pin))) {
    return res.status(401).json({ error: 'Current PIN is incorrect' });
  }
  const newHash = await bcrypt.hash(String(newPin), BCRYPT_ROUNDS);
  await dbRun('UPDATE users SET pin = ? WHERE id = ?', [newHash, user.id]);
  res.json({ ok: true });
});

app.post('/api/send-email', async (req, res) => {
  const { assignee, task, dueDate, assignedBy } = req.body;

  if (!assignee || !task) {
    return res.status(400).json({ error: 'assignee and task are required' });
  }

  const names = parseAssignees(assignee);
  const emails = emailsForAssignees(names);
  if (emails.length === 0) {
    return res.json({ sent: false, reason: 'No emails on file for: ' + names.join(', ') });
  }

  if (!process.env.SENDGRID_API_KEY) {
    return res.status(500).json({ error: 'SENDGRID_API_KEY is not configured' });
  }

  const assigneeDisplay = names.join(', ');

  try {
    const result = await sgMail.send({
      from: FROM_ADDRESS,
      to: emails,
      subject: 'Ranch Hand — New Task Assigned to You',
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:500px;margin:0 auto;padding:20px;">
          <h2 style="color:#2C2C2C;margin-bottom:4px;">New Task Assigned</h2>
          <p style="color:#888;font-size:14px;margin-top:0;">From Ranch Hand / Capitol Cowboys Operations</p>
          <hr style="border:none;border-top:2px solid #C9A84C;margin:16px 0;">
          <p><strong>Task:</strong> ${task}</p>
          <p><strong>Assigned To:</strong> ${assigneeDisplay}</p>
          ${dueDate ? `<p><strong>Due Date:</strong> ${dueDate}</p>` : ''}
          ${assignedBy ? `<p><strong>Assigned By:</strong> ${assignedBy}</p>` : ''}
          <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
          <p style="color:#999;font-size:12px;">This notification was sent by Ranch Hand, the AI operations assistant for Capitol Cowboys LLC.</p>
        </div>
      `,
    });

    console.log('SendGrid response status:', result?.[0]?.statusCode);
    res.json({ sent: true, recipients: emails });
  } catch (err) {
    console.error('Email send error:', err.message);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// ── Conversation Memory API ──

app.get('/api/memory/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const memories = await dbAll(
    `SELECT * FROM conversation_memory WHERE session_id = ? ORDER BY created_at DESC LIMIT 5`,
    [sessionId]
  );
  res.json(memories.reverse());
});

app.delete('/api/memory/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  await dbRun(`DELETE FROM conversation_memory WHERE session_id = ?`, [sessionId]);
  res.json({ cleared: true });
});

// ── Task API ──

app.get('/api/tasks', async (req, res) => {
  const tasks = await dbAll('SELECT * FROM tasks ORDER BY created_at DESC');
  res.json(tasks);
});

app.post('/api/tasks', async (req, res) => {
  const { title, description, assigned_to, due_date, status } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  const names = parseAssignees(assigned_to);
  const assignedToStr = names.join(', ');
  const assignedEmailStr = emailsForAssignees(names).join(',');

  const result = await dbRun(
    `INSERT INTO tasks (title, description, assigned_to, assigned_email, due_date, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [title, description || '', assignedToStr, assignedEmailStr, due_date || '', status || 'pending']
  );

  const task = await dbGet('SELECT * FROM tasks WHERE id = ?', [Number(result.lastInsertRowid)]);
  res.json(task);
});

app.patch('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const { title, description, assigned_to, due_date, status } = req.body;

  const existing = await dbGet('SELECT * FROM tasks WHERE id = ?', [Number(id)]);
  if (!existing) {
    return res.status(404).json({ error: 'Task not found' });
  }

  let assignedToStr = existing.assigned_to;
  let assignedEmailStr = existing.assigned_email;
  if (assigned_to !== undefined) {
    const names = parseAssignees(assigned_to);
    assignedToStr = names.join(', ');
    assignedEmailStr = emailsForAssignees(names).join(',');
  }

  await dbRun(
    `UPDATE tasks SET title = ?, description = ?, assigned_to = ?, assigned_email = ?, due_date = ?, status = ? WHERE id = ?`,
    [
      title !== undefined ? title : existing.title,
      description !== undefined ? description : existing.description,
      assignedToStr,
      assignedEmailStr,
      due_date !== undefined ? due_date : existing.due_date,
      status !== undefined ? status : existing.status,
      Number(id)
    ]
  );

  const updated = await dbGet('SELECT * FROM tasks WHERE id = ?', [Number(id)]);
  res.json(updated);
});

app.delete('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const existing = await dbGet('SELECT * FROM tasks WHERE id = ?', [Number(id)]);
  if (!existing) {
    return res.status(404).json({ error: 'Task not found' });
  }
  await dbRun('DELETE FROM tasks WHERE id = ?', [Number(id)]);
  res.json({ deleted: true });
});

// ── Automated Task Reminders (daily at 9 AM ET) ──

async function sendReminderEmail(task, type) {
  const emails = (task.assigned_email || '').split(',').map(e => e.trim()).filter(Boolean);
  if (emails.length === 0 || !process.env.SENDGRID_API_KEY) return;

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
    await sgMail.send({
      from: FROM_ADDRESS,
      to: emails,
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
    console.log(`[Reminder] ${type} email sent to ${emails.join(', ')} for: ${task.title}`);
  } catch (err) {
    console.error(`[Reminder] Failed to send ${type} email to ${emails.join(', ')}:`, err.message);
  }
}

async function runDailyReminders() {
  console.log('[Reminder] Running daily task check...');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];

  const twoDaysOut = new Date(today);
  twoDaysOut.setDate(twoDaysOut.getDate() + 2);
  const twoDaysStr = twoDaysOut.toISOString().split('T')[0];

  const upcoming = await dbAll(
    `SELECT * FROM tasks WHERE due_date != '' AND due_date >= ? AND due_date <= ? AND status IN ('pending', 'in-progress') AND assigned_email != ''`,
    [todayStr, twoDaysStr]
  );

  const overdue = await dbAll(
    `SELECT * FROM tasks WHERE due_date != '' AND due_date < ? AND status IN ('pending', 'in-progress') AND assigned_email != ''`,
    [todayStr]
  );

  console.log(`[Reminder] Found ${upcoming.length} upcoming, ${overdue.length} overdue tasks`);

  for (const task of upcoming) await sendReminderEmail(task, 'upcoming');
  for (const task of overdue) await sendReminderEmail(task, 'overdue');
}

// ── Weekly Digest (Mondays at 8 AM) ──

function formatDateNice(dateStr) {
  if (!dateStr) return 'No date';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function taskRow(task) {
  return `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;">${task.title}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;">${task.assigned_to || 'Unassigned'}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;">${formatDateNice(task.due_date)}</td>
  </tr>`;
}

function taskSection(title, tasks, color, emptyMsg) {
  if (tasks.length === 0) {
    return `<h3 style="color:${color};margin:20px 0 6px;">${title}</h3>
      <p style="color:#999;font-size:14px;">${emptyMsg}</p>`;
  }
  return `<h3 style="color:${color};margin:20px 0 6px;">${title} (${tasks.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr style="background:#f5f5f5;">
        <th style="padding:6px 10px;text-align:left;">Task</th>
        <th style="padding:6px 10px;text-align:left;">Owner</th>
        <th style="padding:6px 10px;text-align:left;">Due</th>
      </tr>
      ${tasks.map(taskRow).join('')}
    </table>`;
}

async function sendWeeklyDigest() {
  const emails = (process.env.LEADERSHIP_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
  if (emails.length === 0 || !process.env.SENDGRID_API_KEY) {
    console.log('[Digest] No LEADERSHIP_EMAILS or SENDGRID_API_KEY configured, skipping');
    return;
  }

  console.log('[Digest] Compiling weekly digest...');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];

  // End of this week (Sunday)
  const endOfWeek = new Date(today);
  endOfWeek.setDate(endOfWeek.getDate() + (7 - endOfWeek.getDay()));
  const endOfWeekStr = endOfWeek.toISOString().split('T')[0];

  // 7 days ago
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysAgoStr = sevenDaysAgo.toISOString().split('T')[0];

  const dueThisWeek = await dbAll(
    `SELECT * FROM tasks WHERE due_date >= ? AND due_date <= ? AND status IN ('pending', 'in-progress') ORDER BY due_date ASC`,
    [todayStr, endOfWeekStr]
  );

  const overdue = await dbAll(
    `SELECT * FROM tasks WHERE due_date != '' AND due_date < ? AND status IN ('pending', 'in-progress') ORDER BY due_date ASC`,
    [todayStr]
  );

  const completed = await dbAll(
    `SELECT * FROM tasks WHERE status = 'done' AND due_date >= ? ORDER BY due_date ASC`,
    [sevenDaysAgoStr]
  );

  const allActive = await dbAll(`SELECT * FROM tasks WHERE status IN ('pending', 'in-progress')`);
  const totalActive = allActive.length;

  const mondayDate = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <div style="background:#2C2C2C;color:#fff;padding:18px 20px;border-radius:12px 12px 0 0;">
        <h1 style="color:#C9A84C;margin:0;font-size:20px;">Ranch Hand — Weekly Briefing</h1>
        <p style="color:#aaa;margin:4px 0 0;font-size:13px;">${mondayDate}</p>
      </div>

      <div style="border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;padding:20px;">
        <p style="font-size:15px;color:#333;margin-top:0;">Here's where things stand this week. <strong>${totalActive}</strong> active task${totalActive !== 1 ? 's' : ''} across the board.</p>

        ${overdue.length > 0
          ? `<div style="background:#fff5f5;border-left:4px solid #c0392b;padding:10px 14px;margin:12px 0;border-radius:4px;">
              <strong style="color:#c0392b;">${overdue.length} task${overdue.length !== 1 ? 's are' : ' is'} overdue.</strong> These need attention today.
            </div>`
          : `<div style="background:#f0faf0;border-left:4px solid #27ae60;padding:10px 14px;margin:12px 0;border-radius:4px;">
              <strong style="color:#27ae60;">No overdue tasks.</strong> Clean slate.
            </div>`
        }

        ${taskSection('Overdue', overdue, '#c0392b', '')}
        ${taskSection('Due This Week', dueThisWeek, '#C9A84C', 'Nothing due this week.')}
        ${taskSection('Completed (Last 7 Days)', completed, '#27ae60', 'No tasks completed this past week.')}

        <hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px;">
        <p style="color:#999;font-size:12px;margin:0;">— Ranch Hand, Capitol Cowboys Operations Assistant</p>
      </div>
    </div>
  `;

  for (const email of emails) {
    try {
      await sgMail.send({
        from: FROM_ADDRESS,
        to: email,
        subject: `Ranch Hand — Weekly Briefing: ${mondayDate}`,
        html,
      });
      console.log(`[Digest] Sent weekly digest to ${email}`);
    } catch (err) {
      console.error(`[Digest] Failed to send digest to ${email}:`, err.message);
    }
  }
}

// ── Partiful integration ──
// Pulls event metadata (scraped from the public page) and the guest list
// (via api.partiful.com/getGuests) into our Turso tables. The auth token
// lives in PARTIFUL_AUTH_TOKEN and is a short-lived Firebase JWT (~1h TTL),
// so sync runs will start failing when it expires until it's rotated.
const PARTIFUL_API_BASE = 'https://api.partiful.com';

async function scrapePartifulEvent(eventId) {
  const res = await fetch(`https://partiful.com/e/${eventId}`);
  if (!res.ok) throw new Error(`event page returned ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const rawName = $('meta[property="og:title"]').attr('content') || '';
  // Trim the trailing " | Partiful" suffix and a leading "RSVP to " if present
  const name = rawName
    .replace(/\s*\|\s*Partiful\s*$/i, '')
    .replace(/^RSVP to\s+/i, '')
    .trim();
  const startIso = $('time').attr('datetime') || '';
  return { name, startIso };
}

async function fetchPartifulGuests(eventId) {
  const token = process.env.PARTIFUL_AUTH_TOKEN;
  if (!token) throw new Error('PARTIFUL_AUTH_TOKEN is not set');
  const res = await fetch(`${PARTIFUL_API_BASE}/getGuests`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({ data: { params: { eventId } } }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`getGuests returned ${res.status}: ${body}`);
  }
  const json = await res.json();
  return (json.result && json.result.data) || [];
}

async function syncPartifulData(eventId) {
  const id = eventId || process.env.PARTIFUL_EVENT_ID;
  if (!id) throw new Error('no event id (pass arg or set PARTIFUL_EVENT_ID)');

  const [event, guests] = await Promise.all([
    scrapePartifulEvent(id).catch(err => {
      console.warn('[Partiful] event scrape failed:', err.message);
      return { name: '', startIso: '' };
    }),
    fetchPartifulGuests(id),
  ]);

  const counts = { APPROVED: 0, MAYBE: 0, DECLINED: 0, WAITLIST: 0 };
  let plusOnes = 0;
  for (const g of guests) {
    const s = String(g.status || '').toUpperCase();
    if (s in counts) counts[s]++;
    plusOnes += Number(g.plusOneCount || (Array.isArray(g.plusOnes) ? g.plusOnes.length : 0)) || 0;
  }

  // Upsert events row. Using DELETE+INSERT since SQLite UPSERT syntax varies
  // between sql.js and Turso — this is simpler and we're only writing one row.
  await dbRun('DELETE FROM events WHERE event_id = ?', [id]);
  await dbRun(
    `INSERT INTO events
       (event_id, event_name, event_date, total_guests, plus_ones,
        approved, maybe, declined, waitlist, last_synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      id, event.name, event.startIso,
      guests.length, plusOnes,
      counts.APPROVED, counts.MAYBE, counts.DECLINED, counts.WAITLIST,
    ]
  );

  // Snapshot-replace the guest list for this event — simpler than diff-merging.
  await dbRun('DELETE FROM event_guests WHERE event_id = ?', [id]);
  for (const g of guests) {
    await dbRun(
      `INSERT INTO event_guests
         (event_id, guest_name, status, plus_one_count, rsvp_date, last_synced)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [
        id,
        String(g.name || '').trim(),
        String(g.status || '').toUpperCase(),
        Number(g.plusOneCount || 0) || 0,
        String(g.rsvpDate || ''),
      ]
    );
  }

  return {
    eventId: id,
    eventName: event.name,
    eventDate: event.startIso,
    totalGuests: guests.length,
    plusOnes,
    counts,
  };
}

app.post('/api/partiful/sync', async (req, res) => {
  const eventId = (req.body && req.body.eventId) || process.env.PARTIFUL_EVENT_ID;
  if (!eventId) return res.status(400).json({ error: 'eventId is required' });
  try {
    const result = await syncPartifulData(eventId);
    console.log(`[Partiful] Manual sync OK — ${result.totalGuests} guests, ${result.plusOnes} +1s (${eventId})`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[Partiful] Sync failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/partiful/events', async (req, res) => {
  try {
    const eventId = req.query.eventId || process.env.PARTIFUL_EVENT_ID;
    const events = eventId
      ? await dbAll('SELECT * FROM events WHERE event_id = ?', [eventId])
      : await dbAll('SELECT * FROM events ORDER BY last_synced DESC');
    if (events.length === 0) return res.json({ events: [], guests: [] });
    const primary = events[0];
    const guests = await dbAll(
      `SELECT guest_name, status, plus_one_count, rsvp_date
       FROM event_guests
       WHERE event_id = ?
       ORDER BY rsvp_date DESC`,
      [primary.event_id]
    );
    res.json({ event: primary, events, guests });
  } catch (err) {
    console.error('[Partiful] Fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Ranch Hand running on http://localhost:${PORT}`);
  });

  // Daily reminders at 9:00 AM
  cron.schedule('0 9 * * *', () => {
    runDailyReminders();
  });
  console.log('[Reminder] Daily reminder cron scheduled for 9:00 AM');

  // Weekly digest every Monday at 8:00 AM
  cron.schedule('0 8 * * 1', () => {
    sendWeeklyDigest();
  });
  console.log('[Digest] Weekly digest cron scheduled for Mondays at 8:00 AM');

  // Partiful auto-sync every 2 hours (top of even hours).
  // If PARTIFUL_EVENT_ID is unset, skip silently — this lets non-Derby deploys
  // run without constant error logs.
  if (process.env.PARTIFUL_EVENT_ID) {
    cron.schedule('0 */2 * * *', async () => {
      try {
        const r = await syncPartifulData();
        console.log(`[Partiful] Auto-sync OK — ${r.totalGuests} guests, ${r.plusOnes} +1s`);
      } catch (err) {
        console.error('[Partiful] Auto-sync failed:', err.message);
      }
    });
    console.log('[Partiful] Auto-sync cron scheduled for every 2 hours');
  } else {
    console.log('[Partiful] PARTIFUL_EVENT_ID not set — auto-sync disabled');
  }
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
