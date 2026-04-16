require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const { Resend } = require('resend');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

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
    saveDb();
    console.log('[DB] Using local sql.js at', DB_PATH);
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

const FROM_ADDRESS = process.env.RESEND_FROM || 'onboarding@resend.dev';

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

app.post('/api/chat', async (req, res) => {
  const { messages, session_id } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
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
          const assignedEmail = MEMBER_EMAILS[t.assigned_to] || '';
          await dbRun(
            `INSERT INTO tasks (title, description, assigned_to, assigned_email, due_date, status)
             VALUES (?, ?, ?, ?, ?, 'pending')`,
            [t.title, t.description || '', t.assigned_to || '', assignedEmail, t.due_date || '']
          );
          created.push({ title: t.title, assigned_to: t.assigned_to, assigned_email: assignedEmail });
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

  const assignedEmail = MEMBER_EMAILS[assigned_to] || '';
  const result = await dbRun(
    `INSERT INTO tasks (title, description, assigned_to, assigned_email, due_date, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [title, description || '', assigned_to || '', assignedEmail, due_date || '', status || 'pending']
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

  const assignedEmail = assigned_to !== undefined
    ? (MEMBER_EMAILS[assigned_to] || '')
    : existing.assigned_email;

  await dbRun(
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
  if (emails.length === 0 || !process.env.RESEND_API_KEY) {
    console.log('[Digest] No LEADERSHIP_EMAILS or RESEND_API_KEY configured, skipping');
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

  const resend = new Resend(process.env.RESEND_API_KEY);

  for (const email of emails) {
    try {
      await resend.emails.send({
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
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
