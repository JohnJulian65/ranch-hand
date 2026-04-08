require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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

app.listen(PORT, () => {
  console.log(`Ranch Hand running on http://localhost:${PORT}`);
});
