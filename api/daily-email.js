const { google } = require('googleapis');
const { OpenAI } = require('openai');
const { Resend } = require('resend');

// ── Auth helpers (reuse sheets pattern) ──────────────────────────────────────
async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

function toBool(v) { return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1'; }
function safeJson(s) { try { return JSON.parse(s); } catch { return []; } }

// ── Load data from Sheets ─────────────────────────────────────────────────────
async function loadData() {
  const sheets = await getSheetsClient();
  const spreadsheetId = '1SK3hsYiff-P3KK96k7cEiFhORB25BROFzS5ADE3XACM';

  const [tasksRes, logRes, catRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId, range: 'Tasks!A:N' }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: 'Log!A:F' }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: 'Categories!A:H' }).catch(() => ({ data: { values: [] } })),
  ]);

  const tasks = (tasksRes.data.values || []).slice(1).map(r => ({
    id: r[0] || '', stream: r[1] || '', text: r[2] || '', pri: r[3] || 'normal',
    dueDate: r[4] || '', note: r[5] || '', done: toBool(r[6]),
    subs: r[7] ? safeJson(r[7]) : [],
    categoryId: r[8] || '', createdAt: r[9] || '',
    isDailyVictory: toBool(r[10]), isWeeklyFocus: toBool(r[11]),
    delegateIntent: toBool(r[12]), delegatedTo: r[13] || '',
  }));

  const log = (logRes.data.values || []).slice(1).map(r => ({
    taskId: r[0] || '', completedAt: r[1] || '', dueDate: r[2] || '',
    daysLate: r[3] ?? null, weekStart: r[4] || '', delegatedTo: r[5] || '',
  }));

  const categories = (catRes.data.values || []).slice(1).map(r => ({
    id: r[0] || '', name: r[1] || '', color: r[2] || '',
    vision: r[3] || '', purpose: r[4] || '', result: r[5] || '',
    createdAt: r[6] || '', archived: toBool(r[7]),
  }));

  return { tasks, log, categories };
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function todayAEST() {
  // AEST = UTC+10
  const d = new Date(Date.now() + 10 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
function fmtDate(d) {
  if (!d) return '';
  const [, m, day] = d.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(day)} ${months[parseInt(m) - 1]}`;
}
function daysDiff(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}

// ── Compute briefing data ─────────────────────────────────────────────────────
function computeBriefing(tasks, log, categories, today) {
  const pending = tasks.filter(t => !t.done);
  const overdue = pending.filter(t => t.dueDate && t.dueDate < today);
  const dueToday = pending.filter(t => t.dueDate === today);
  const victories = tasks.filter(t => t.isDailyVictory);
  const pendingDelegations = pending.filter(t => t.delegateIntent);
  const weeklyFocus = pending.filter(t => t.isWeeklyFocus);

  // Completion rate: last 7 days
  const sevenDaysAgo = new Date(today + 'T00:00:00');
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenAgo = sevenDaysAgo.toISOString().slice(0, 10);
  const recentLog = log.filter(e => e.completedAt >= sevenAgo);
  const completionRate = tasks.length > 0
    ? Math.round((tasks.filter(t => t.done).length / tasks.length) * 100) : 0;

  // Category task counts
  const catStats = categories.filter(c => !c.archived).map(c => {
    const total = tasks.filter(t => t.categoryId === c.id).length;
    const done = tasks.filter(t => t.categoryId === c.id && t.done).length;
    return { ...c, total, done, open: total - done, pct: total > 0 ? Math.round(done / total * 100) : 0 };
  }).filter(c => c.total > 0);

  return { pending, overdue, dueToday, victories, pendingDelegations, weeklyFocus, completionRate, recentLog, catStats };
}

// ── AI Synthesis ──────────────────────────────────────────────────────────────
async function generateBriefing(data, categories, today) {
  const { overdue, dueToday, victories, pendingDelegations, pending, completionRate, weeklyFocus, catStats } = data;

  const catVisionStr = categories.filter(c => !c.archived && c.vision)
    .map(c => `- ${c.name}: ${c.vision}`)
    .join('\n');

  const overdueStr = overdue.slice(0, 8)
    .map(t => `• ${t.text} (${daysDiff(t.dueDate, today)}d late, ${t.stream})`)
    .join('\n') || 'None';

  const dueTodayStr = dueToday.slice(0, 8)
    .map(t => `• ${t.text} [${t.pri}] (${t.stream})`)
    .join('\n') || 'None';

  const delegationsStr = pendingDelegations.slice(0, 5)
    .map(t => `• ${t.text}${t.delegatedTo ? ' → ' + t.delegatedTo : ''} (${t.stream})`)
    .join('\n') || 'None';

  const weeklyFocusStr = weeklyFocus.slice(0, 5)
    .map(t => `• ${t.text} (${t.stream})`)
    .join('\n') || 'None';

  const topPendingStr = pending
    .filter(t => ['urgent', 'priority'].includes(t.pri))
    .slice(0, 10)
    .map(t => `• [${t.pri}] ${t.text} (${t.stream}${t.dueDate ? ', due ' + fmtDate(t.dueDate) : ''})`)
    .join('\n') || 'None';

  const catProgressStr = catStats.slice(0, 6)
    .map(c => `• ${c.name}: ${c.done}/${c.total} done (${c.pct}%)`)
    .join('\n');

  const prompt = `You are Jacy's personal strategic assistant preparing their morning briefing for ${today}.

JACY'S RPM VISION (what drives their goals):
${catVisionStr || 'Not yet defined'}

TODAY'S SITUATION:
Overdue tasks (${overdue.length} total):
${overdueStr}

Due today (${dueToday.length} tasks):
${dueTodayStr}

Weekly focus tasks:
${weeklyFocusStr}

High-priority pending tasks:
${topPendingStr}

Pending delegations (${pendingDelegations.length}):
${delegationsStr}

Overall completion rate: ${completionRate}%
Tasks completed in last 7 days: ${data.recentLog.length}

Category progress:
${catProgressStr}

Write Jacy's morning briefing with the following structure. Be direct, insightful, and brief. This is a business partner speaking, not a life coach:

**STRATEGIC FOCUS** (2-3 sentences): What's the single most important thing to move on today and why? Reference their vision where relevant.

**PATTERNS & RISKS** (2-3 sentences): What patterns do you notice in the data? Any risks, blockers or neglected areas worth flagging?

**DELEGATION NUDGE** (1-2 sentences): Specific advice about their delegation habit — what should they be handing off, or what's stuck?

**TODAY'S RECOMMENDATION**: List exactly 5 specific tasks from their pending list that should be today's Daily Victories. Choose based on urgency, vision alignment, and momentum. Format as a numbered list.

**ONE INSIGHT**: One sharp, honest observation about their work patterns or strategic position. Make it worth reading.

Keep the total under 300 words. Write in second person ("You have...", "Your...").`;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 800,
    temperature: 0.7,
    messages: [{ role: 'user', content: prompt }],
  });

  return res.choices[0].message.content || '';
}

// ── HTML Email ────────────────────────────────────────────────────────────────
function buildEmail(briefingText, data, today) {
  const { overdue, dueToday, victories, pendingDelegations, completionRate } = data;

  const priColor = { urgent: '#a32d2d', priority: '#993c1d', normal: '#555', backburner: '#888' };

  function taskRow(t, showDue = true) {
    const daysLate = t.dueDate && t.dueDate < today ? daysDiff(t.dueDate, today) : 0;
    return `<tr>
      <td style="padding:5px 8px;font-size:13px;color:#222;border-bottom:1px solid #f5f5f5">${t.text}</td>
      <td style="padding:5px 8px;font-size:11px;color:${priColor[t.pri] || '#888'};border-bottom:1px solid #f5f5f5;white-space:nowrap">${t.pri !== 'normal' ? t.pri : ''}</td>
      ${showDue ? `<td style="padding:5px 8px;font-size:11px;color:${daysLate > 0 ? '#a32d2d' : '#888'};border-bottom:1px solid #f5f5f5;white-space:nowrap">${t.dueDate ? fmtDate(t.dueDate) + (daysLate > 0 ? ` · ${daysLate}d late` : '') : ''}</td>` : ''}
    </tr>`;
  }

  // Convert AI briefing markdown-ish sections to HTML
  const briefingHtml = briefingText
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#222">$1</strong>')
    .replace(/\n\n/g, '</p><p style="margin:0 0 10px;line-height:1.6">')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p style="margin:0 0 10px;line-height:1.6">')
    .replace(/$/, '</p>');

  const fmtToday = (() => {
    const d = new Date(today + 'T00:00:00');
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]}`;
  })();

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8f8f6;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">

  <!-- Header -->
  <div style="background:#222;border-radius:10px;padding:20px 24px;margin-bottom:16px">
    <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px">RPM Daily Briefing</div>
    <div style="font-size:20px;font-weight:700;color:#fff">${fmtToday}</div>
    <div style="display:flex;gap:16px;margin-top:12px;flex-wrap:wrap">
      <span style="font-size:12px;color:#aaa">📋 ${data.pending.length} open tasks</span>
      <span style="font-size:12px;color:${overdue.length > 0 ? '#f09595' : '#aaa'}">🔴 ${overdue.length} overdue</span>
      <span style="font-size:12px;color:#aaa">📅 ${dueToday.length} due today</span>
      <span style="font-size:12px;color:#aaa">✅ ${completionRate}% complete</span>
    </div>
  </div>

  <!-- AI Briefing -->
  <div style="background:#fff;border-radius:10px;padding:20px 24px;margin-bottom:16px;border:1px solid #eee">
    <div style="font-size:11px;font-weight:700;color:#BA7517;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px">🤖 Strategic Briefing</div>
    <div style="font-size:13px;color:#333">${briefingHtml}</div>
  </div>

  ${dueToday.length > 0 ? `
  <!-- Due Today -->
  <div style="background:#fff;border-radius:10px;padding:20px 24px;margin-bottom:16px;border:1px solid #eee">
    <div style="font-size:11px;font-weight:700;color:#378ADD;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px">📅 Due Today (${dueToday.length})</div>
    <table style="width:100%;border-collapse:collapse">
      ${dueToday.map(t => taskRow(t, false)).join('')}
    </table>
  </div>` : ''}

  ${overdue.length > 0 ? `
  <!-- Overdue -->
  <div style="background:#fff;border-radius:10px;padding:20px 24px;margin-bottom:16px;border:1px solid #fee;border-left:3px solid #f09595">
    <div style="font-size:11px;font-weight:700;color:#a32d2d;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px">🔴 Overdue (${overdue.length})</div>
    <table style="width:100%;border-collapse:collapse">
      ${overdue.slice(0, 10).map(t => taskRow(t)).join('')}
    </table>
    ${overdue.length > 10 ? `<div style="font-size:11px;color:#aaa;margin-top:8px">+ ${overdue.length - 10} more overdue tasks</div>` : ''}
  </div>` : ''}

  ${pendingDelegations.length > 0 ? `
  <!-- Delegations -->
  <div style="background:#fff;border-radius:10px;padding:20px 24px;margin-bottom:16px;border:1px solid #eee">
    <div style="font-size:11px;font-weight:700;color:#2050a0;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px">🤝 Pending Delegations (${pendingDelegations.length})</div>
    <table style="width:100%;border-collapse:collapse">
      ${pendingDelegations.map(t => `<tr>
        <td style="padding:5px 8px;font-size:13px;color:#222;border-bottom:1px solid #f5f5f5">${t.text}</td>
        <td style="padding:5px 8px;font-size:11px;color:#2050a0;border-bottom:1px solid #f5f5f5">${t.delegatedTo || 'unassigned'}</td>
      </tr>`).join('')}
    </table>
  </div>` : ''}

  ${victories.length > 0 ? `
  <!-- Daily Victories -->
  <div style="background:#fffcf0;border-radius:10px;padding:20px 24px;margin-bottom:16px;border:1px solid #e4cb78">
    <div style="font-size:11px;font-weight:700;color:#7a5c0a;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px">⭐ Your 5 Daily Victories</div>
    ${victories.slice(0, 5).map(t => `
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0">
        <div style="width:12px;height:12px;border-radius:3px;background:${t.done ? '#BA7517' : 'transparent'};border:1.5px solid #d4a820;flex-shrink:0"></div>
        <span style="font-size:13px;color:${t.done ? '#c0aa70' : '#5a4008'};${t.done ? 'text-decoration:line-through' : ''}">${t.text}</span>
      </div>`).join('')}
  </div>` : ''}

  <!-- Footer -->
  <div style="text-align:center;padding:12px">
    <a href="https://jacy-the-great.github.io/RPM-plan/RPM_Dashboard_Updated_1.html"
       style="display:inline-block;padding:10px 24px;background:#222;color:#fff;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">
      Open RPM Dashboard →
    </a>
    <div style="font-size:10px;color:#bbb;margin-top:10px">RPM Dashboard · Daily briefing generated by GPT-4o Mini</div>
  </div>

</div>
</body>
</html>`;
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Basic security: require a secret for non-cron calls
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'];
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  if (cronSecret && !isVercelCron && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const today = todayAEST();
    console.log(`Generating daily briefing for ${today}`);

    const { tasks, log, categories } = await loadData();
    const briefingData = computeBriefing(tasks, log, categories, today);

    console.log(`Loaded: ${tasks.length} tasks, ${briefingData.overdue.length} overdue, ${briefingData.dueToday.length} due today`);

    const briefingText = await generateBriefing(briefingData, categories, today);
    console.log('AI briefing generated');

    const emailHtml = buildEmail(briefingText, briefingData, today);

    const resend = new Resend(process.env.RESEND_API_KEY);
    const recipientEmail = process.env.RECIPIENT_EMAIL || 'jacymacnee1@gmail.com';

    const { data, error } = await resend.emails.send({
      from: 'RPM Dashboard <onboarding@resend.dev>',
      to: recipientEmail,
      subject: `🌅 RPM Briefing — ${briefingData.dueToday.length} due today, ${briefingData.overdue.length} overdue`,
      html: emailHtml,
    });

    if (error) throw new Error(JSON.stringify(error));

    console.log('Email sent:', data?.id);
    res.status(200).json({ success: true, emailId: data?.id, today, stats: {
      tasks: tasks.length,
      overdue: briefingData.overdue.length,
      dueToday: briefingData.dueToday.length,
    }});

  } catch (err) {
    console.error('Daily email error:', err);
    res.status(500).json({ error: err.message });
  }
};
