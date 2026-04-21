// One-shot: seed the Derby push tasks requested on 2026-04-20.
// Targets Turso (prod) via @libsql/client when TURSO_DATABASE_URL is set.
// Idempotent: skips any (title, assigned_to) pair that already exists.
require('dotenv').config();
const { createClient } = require('@libsql/client/web');

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set. Aborting.');
  process.exit(1);
}

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
const ALL = Object.keys(MEMBER_EMAILS);

const allMembersTasks = [
  {
    title: 'Work personal networks for Derby ticket sales',
    description: '[Priority: High] Tell friends, have girlfriends tell their friends, buy tickets, bring people. 15 tickets behind pace — this week is critical.',
    due_date: '2026-04-24',
  },
  {
    title: 'Share and repost CC Instagram stories + comment on posts',
    description: "[Priority: Medium] When JM tags everyone, share to your stories. Increase commenting on CC posts — internal engagement needs to improve per César's feedback.",
    due_date: '',
  },
  {
    title: 'Identify high-influence contacts for potential comp tickets',
    description: '[Priority: Medium] If you know someone like Jeff or CJ whose network will show up, flag them to leadership. Their circle attending is worth comping a ticket.',
    due_date: '2026-04-24',
  },
  {
    title: 'Submit content ideas and language suggestions for Derby marketing',
    description: '[Priority: Medium] Leadership is open to input on messaging, content angles, and language for the final ticket push.',
    due_date: '2026-04-20',
  },
];

const singleTasks = [
  {
    title: 'Create 3 Instagram stories showcasing Derby party offerings',
    description: '[Priority: High] Three stories highlighting what is being offered at the Derby party, paired with urgency-driven messaging in text blasts.',
    assigned_to: 'Jon Michael',
    due_date: '2026-04-24',
  },
  {
    title: 'Execute two-week content schedule',
    description: '[Priority: High] This week — video thumbnail, text blasts Tue, story Wed, text blast Thu, story Fri. Next week — story Mon, text blasts Tue, story Wed, text blasts Thu and Fri. Anyone interested in giving input on text blast copy should reach out to JM.',
    assigned_to: 'Jon Michael',
    due_date: '2026-05-01',
  },
  {
    title: 'Check city event calendar before setting next Happy Hour date',
    description: '[Priority: Medium] Last HH competed with a big EDM concert on Penn Ave. Going forward, cross-reference D.C. events before locking in dates.',
    assigned_to: 'Cesar',
    due_date: '',
  },
];

(async () => {
  const db = createClient({ url, authToken });

  const rows = [];
  for (const t of allMembersTasks) {
    for (const name of ALL) {
      rows.push({
        title: t.title,
        description: t.description,
        assigned_to: name,
        assigned_email: MEMBER_EMAILS[name],
        due_date: t.due_date,
      });
    }
  }
  for (const t of singleTasks) {
    rows.push({
      title: t.title,
      description: t.description,
      assigned_to: t.assigned_to,
      assigned_email: MEMBER_EMAILS[t.assigned_to],
      due_date: t.due_date,
    });
  }

  let inserted = 0;
  let skipped = 0;
  for (const r of rows) {
    const existing = await db.execute({
      sql: 'SELECT id FROM tasks WHERE title = ? AND assigned_to = ? LIMIT 1',
      args: [r.title, r.assigned_to],
    });
    if (existing.rows.length > 0) {
      skipped++;
      console.log(`  skip (exists): ${r.title} → ${r.assigned_to}`);
      continue;
    }
    await db.execute({
      sql: `INSERT INTO tasks (title, description, assigned_to, assigned_email, due_date, status)
            VALUES (?, ?, ?, ?, ?, 'pending')`,
      args: [r.title, r.description, r.assigned_to, r.assigned_email, r.due_date],
    });
    inserted++;
  }

  console.log(`\nInserted: ${inserted}`);
  console.log(`Skipped (already existed): ${skipped}`);
  console.log(`Total processed: ${rows.length}`);
})().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
