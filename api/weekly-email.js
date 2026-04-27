const { google } = require('googleapis');
const { OpenAI } = require('openai');
const { Resend } = require('resend');

// ── Auth / data loading (mirrors daily-email.js) ──────────────────────────────
async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}
function toBool(v) { return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1'; }
function safeJson(s) { try { return JSON.parse(s); } catch { return []; } }

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
  const d = new Date(Date.now() + 10 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
function weekStartOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0=Sun
  const mon = new Date(d); mon.setDate(d.getDate() - ((day + 6) % 7));
  return mon.toISOString().slice(0, 10);
}
function daysDiff(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}
function fmtDate(d) {
  if (!d) return '';
  const [, m, day] = d.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(day)} ${months[parseInt(m) - 1]}`;
}
function leafCount(t) { return 1 + (t.subs || []).length; }
function doneCount(t) { return (t.done ? 1 : 0) + ((t.subs || []).filter(s => s.done).length); }

// ── Compute weekly analytics ──────────────────────────────────────────────────
function computeWeekly(tasks, log, categories, today) {
  const thisWeekStart = weekStartOf(today);
  const lastWeekStart = (() => { const d = new Date(thisWeekStart + 'T00:00:00'); d.setDate(d.getDate()-7); return d.toISOString().slice(0,10); })();

  // Tasks completed this week
  const completedThisWeek = log.filter(e => e.weekStart === thisWeekStart);
  const completedTasksThisWeek = completedThisWeek
    .map(e => tasks.find(t => t.id === e.taskId))
    .filter(Boolean);

  // Tasks completed last week (for comparison)
  const completedLastWeek = log.filter(e => e.weekStart === lastWeekStart);

  // Weekly focus items
  const weeklyFocus = tasks.filter(t => t.isWeeklyFocus);
  const weeklyFocusDone = weeklyFocus.filter(t => t.done);

  // Daily victories completed this week
  const victoriesThisWeek = completedTasksThisWeek.filter(t => t.isDailyVictory);

  // Currently open tasks
  const open = tasks.filter(t => !t.done);
  const overdue = open.filter(t => t.dueDate && t.dueDate < today);
  const dueNextWeek = open.filter(t => {
    if (!t.dueDate) return false;
    const dd = daysDiff(today, t.dueDate);
    return dd >= 0 && dd <= 7;
  });

  // Delegation stats
  const delegatedThisWeek = completedThisWeek.filter(e => e.delegatedTo).length;
  const pendingDelegations = open.filter(t => t.delegateIntent);

  // On-time vs late completions this week
  const onTime = completedThisWeek.filter(e => !e.daysLate || Number(e.daysLate) <= 0).length;
  const late = completedThisWeek.filter(e => e.daysLate && Number(e.daysLate) > 0).length;

  // By-stream completion this week
  const byStream = {};
  completedTasksThisWeek.forEach(t => {
    if (!byStream[t.stream]) byStream[t.stream] = 0;
    byStream[t.stream]++;
  });

  // Total items (matching dashboard leafCount)
  let totalItems = 0, doneItems = 0;
  tasks.forEach(t => { totalItems += leafCount(t); doneItems += doneCount(t); });
  const completionRate = totalItems > 0 ? Math.round(doneItems / totalItems * 100) : 0;

  // Oldest open tasks (procrastination flags)
  const oldOpen = open
    .filter(t => t.createdAt && daysDiff(t.createdAt, today) >= 14)
    .sort((a, b) => (a.createdAt || '') < (b.createdAt || '') ? -1 : 1)
    .slice(0, 5);

  // Category progress
  const catProgress = categories.filter(c => !c.archived).map(c => {
    const ct = tasks.filter(t => t.categoryId === c.id);
    const done = ct.filter(t => t.done).length;
    return { ...c, total: ct.length, done, open: ct.length - done, pct: ct.length > 0 ? Math.round(done / ct.length * 100) : 0 };
  }).filter(c => c.total > 0).sort((a, b) => b.total - a.total);

  return {
    thisWeekStart, lastWeekStart,
    completedThisWeek: completedTasksThisWeek,
    completedCount: completedThisWeek.length,
    lastWeekCount: completedLastWeek.length,
    weeklyFocus, weeklyFocusDone,
    victoriesThisWeek,
    open, overdue, dueNextWeek,
    delegatedThisWeek, pendingDelegations,
    onTime, late,
    byStream, completionRate, totalItems, doneItems,
    oldOpen, catProgress,
  };
}

// ── AI weekly briefing ────────────────────────────────────────────────────────
async function generateWeeklyBriefing(data, categories, priorities, today) {
  const {
    completedThisWeek, completedCount, lastWeekCount,
    weeklyFocus, weeklyFocusDone,
    overdue, dueNextWeek, pendingDelegations,
    delegatedThisWeek, onTime, late,
    byStream, completionRate, oldOpen, catProgress,
    victoriesThisWeek, open,
  } = data;

  const catVisionStr = categories.filter(c => !c.archived && (c.vision || c.result))
    .map(c => `- ${c.name}${c.vision ? ': Vision — ' + c.vision : ''}${c.result ? ' | 90-day goal — ' + c.result : ''}`)
    .join('\n');

  const prioStr = [
    priorities.quarter ? `Quarterly: ${priorities.quarter}` : '',
    priorities.month ? `Monthly: ${priorities.month}` : '',
    priorities.weekly?.length ? `Weekly focus:\n${priorities.weekly.map(w => `  • ${w}`).join('\n')}` : '',
    priorities.threeToThrive?.length ? `3 to Thrive:\n${priorities.threeToThrive.filter(Boolean).map(t => `  • ${t}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const completedStr = completedThisWeek.slice(0, 12)
    .map(t => `• ${t.text} [${t.stream}]`)
    .join('\n') || 'None recorded';

  const focusStr = weeklyFocus.length > 0
    ? weeklyFocus.map(t => `• ${t.text} — ${t.done ? '✓ DONE' : 'NOT DONE'}`)
      .join('\n')
    : 'No weekly focus items set';

  const overdueStr = overdue.slice(0, 8)
    .map(t => `• ${t.text} (${daysDiff(t.dueDate, today)}d late, ${t.stream})`)
    .join('\n') || 'None';

  const nextWeekStr = dueNextWeek.slice(0, 8)
    .map(t => `• ${t.text} [${t.pri}] due ${fmtDate(t.dueDate)} (${t.stream})`)
    .join('\n') || 'None';

  const byStreamStr = Object.entries(byStream)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `• ${s}: ${n} completed`)
    .join('\n') || 'None';

  const oldStr = oldOpen
    .map(t => `• ${t.text} (${daysDiff(t.createdAt, today)}d on tracker, ${t.pri})`)
    .join('\n') || 'None';

  const prompt = `You are Jacy's strategic RPM advisor preparing their WEEKLY review for the week ending ${today}.

RPM VISION & GOALS:
${catVisionStr || 'Not yet defined'}

STRATEGIC PRIORITIES:
${prioStr || 'Not set — encourage Jacy to set these in the dashboard'}

THIS WEEK'S RESULTS:
Tasks completed: ${completedCount} (vs ${lastWeekCount} last week)
On-time completions: ${onTime} | Late completions: ${late}
Delegated this week: ${delegatedThisWeek}
Overall completion rate: ${completionRate}% (${data.doneItems}/${data.totalItems} items)

COMPLETED TASKS:
${completedStr}

WEEKLY FOCUS ITEMS:
${focusStr}

COMPLETED BY STREAM:
${byStreamStr}

OVERDUE (${overdue.length} tasks):
${overdueStr}

DUE NEXT 7 DAYS:
${nextWeekStr}

PENDING DELEGATIONS (${pendingDelegations.length}):
${pendingDelegations.slice(0, 5).map(t => `• ${t.text}${t.delegatedTo ? ' → ' + t.delegatedTo : ''}`).join('\n') || 'None'}

TASKS SITTING LONGEST (possible procrastination):
${oldStr}

Write Jacy's WEEKLY RPM review. Be direct, analytical, and honest. This is a strategic business review, not a pep talk. Structure:

**WEEK IN REVIEW** (2-3 sentences): Honest assessment — strong week or weak? How does it track against priorities?

**VICTORIES THIS WEEK**: List up to 5 specific wins from the completed tasks. Bold and celebrate these.

**PATTERNS & TRENDS** (3-4 sentences): What patterns do you see across streams? Where is momentum building? Where is it stalling? Any streams being neglected?

**GOAL ALIGNMENT** (2-3 sentences): How well did this week's work connect to the stated quarterly/monthly priorities? Be specific about gaps or wins.

**DELEGATION REVIEW** (1-2 sentences): Assess delegation performance — is Jacy delegating enough? Any specific recommendations?

**PROCRASTINATION FLAG**: If any tasks have been sitting longest, call them out directly. Name them and recommend a decision: do it, delegate it, or delete it.

**NEXT WEEK'S PRIORITIES**: Recommend exactly 5 tasks that should be the weekly focus for the coming week, ranked by strategic importance. Format as a numbered list.

**ONE SHARP INSIGHT**: One honest, specific observation about strategic position or habits. Worth the read.

Keep the total under 500 words. Be a trusted advisor, not a cheerleader.`;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1200,
    temperature: 0.7,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.choices[0].message.content || '';
}

// ── HTML Email ────────────────────────────────────────────────────────────────
function buildWeeklyEmail(briefingText, data, categories, today) {
  const {
    completedCount, lastWeekCount, completionRate,
    weeklyFocus, weeklyFocusDone,
    overdue, dueNextWeek, pendingDelegations,
    delegatedThisWeek, onTime, late,
    byStream, catProgress, oldOpen, open,
    totalItems, doneItems,
  } = data;

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

  const weekLabel = `Week ending ${fmtToday}`;
  const trend = completedCount >= lastWeekCount ? '↑' : '↓';
  const trendColor = completedCount >= lastWeekCount ? '#1d9e75' : '#a32d2d';

  const streamRows = Object.entries(byStream).sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `<tr><td style="padding:4px 8px;font-size:13px;color:#222;border-bottom:1px solid #f5f5f5;text-transform:capitalize">${s}</td><td style="padding:4px 8px;font-size:13px;font-weight:600;color:#378ADD;border-bottom:1px solid #f5f5f5">${n}</td></tr>`)
    .join('');

  const catRows = catProgress.slice(0, 8).map(c => {
    const barW = Math.round(c.pct);
    return `<tr>
      <td style="padding:5px 8px;font-size:12px;color:#222;border-bottom:1px solid #f5f5f5">${c.name}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f5f5f5;width:120px">
        <div style="height:6px;background:#eee;border-radius:3px;overflow:hidden">
          <div style="height:6px;width:${barW}%;background:${c.color||'#378ADD'};border-radius:3px"></div>
        </div>
      </td>
      <td style="padding:5px 8px;font-size:11px;color:#888;border-bottom:1px solid #f5f5f5;white-space:nowrap">${c.done}/${c.total} · ${c.pct}%</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8f8f6;font-family:Arial,sans-serif">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">

  <!-- Header -->
  <div style="background:#111;border-radius:10px;padding:22px 26px;margin-bottom:16px">
    <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.12em;margin-bottom:4px">RPM Weekly Review</div>
    <div style="font-size:20px;font-weight:700;color:#fff">${weekLabel}</div>
    <div style="display:flex;gap:16px;margin-top:14px;flex-wrap:wrap">
      <span style="font-size:12px;color:#aaa">✅ ${completedCount} completed <span style="color:${trendColor}">${trend} ${Math.abs(completedCount - lastWeekCount)} vs last week</span></span>
      <span style="font-size:12px;color:#aaa">🔴 ${overdue.length} overdue</span>
      <span style="font-size:12px;color:#aaa">📊 ${completionRate}% overall done</span>
      <span style="font-size:12px;color:#aaa">🤝 ${delegatedThisWeek} delegated</span>
    </div>
  </div>

  <!-- AI Weekly Briefing -->
  <div style="background:#fff;border-radius:10px;padding:22px 26px;margin-bottom:16px;border:1px solid #eee">
    <div style="font-size:11px;font-weight:700;color:#BA7517;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px">🤖 Weekly Strategic Review</div>
    <div style="font-size:13px;color:#333">${briefingHtml}</div>
  </div>

  <!-- Stats row -->
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
    ${[
      ['Completed', completedCount, ''],
      ['On-time', onTime, completedCount > 0 ? Math.round(onTime/completedCount*100)+'%' : ''],
      ['Delegated', delegatedThisWeek, ''],
      ['Open', open.length, `${overdue.length} late`],
    ].map(([label, val, sub]) => `
      <div style="background:#fff;border:1px solid #eee;border-radius:8px;padding:12px 14px;text-align:center">
        <div style="font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">${label}</div>
        <div style="font-size:22px;font-weight:600;color:#222">${val}</div>
        ${sub ? `<div style="font-size:10px;color:#888;margin-top:2px">${sub}</div>` : ''}
      </div>`).join('')}
  </div>

  ${weeklyFocus.length > 0 ? `
  <!-- Weekly Focus -->
  <div style="background:#fff;border-radius:10px;padding:20px 24px;margin-bottom:16px;border:1px solid #eee">
    <div style="font-size:11px;font-weight:700;color:#378ADD;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">🚩 Weekly Focus (${weeklyFocusDone.length}/${weeklyFocus.length} done)</div>
    ${weeklyFocus.map(t => `
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0">
        <div style="width:12px;height:12px;border-radius:3px;background:${t.done ? '#1d9e75' : 'transparent'};border:1.5px solid ${t.done ? '#1d9e75' : '#ccc'};flex-shrink:0"></div>
        <span style="font-size:13px;color:${t.done ? '#888' : '#222'};${t.done ? 'text-decoration:line-through' : ''}">${t.text}</span>
      </div>`).join('')}
  </div>` : ''}

  ${streamRows ? `
  <!-- By Stream -->
  <div style="background:#fff;border-radius:10px;padding:20px 24px;margin-bottom:16px;border:1px solid #eee">
    <div style="font-size:11px;font-weight:700;color:#222;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">📊 Completed by Stream</div>
    <table style="width:100%;border-collapse:collapse">${streamRows}</table>
  </div>` : ''}

  ${catRows ? `
  <!-- Category Progress -->
  <div style="background:#fff;border-radius:10px;padding:20px 24px;margin-bottom:16px;border:1px solid #eee">
    <div style="font-size:11px;font-weight:700;color:#222;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">🎯 Category Progress</div>
    <table style="width:100%;border-collapse:collapse">${catRows}</table>
  </div>` : ''}

  ${dueNextWeek.length > 0 ? `
  <!-- Due Next Week -->
  <div style="background:#fff;border-radius:10px;padding:20px 24px;margin-bottom:16px;border:1px solid #eee">
    <div style="font-size:11px;font-weight:700;color:#993c1d;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">📅 Due This Coming Week (${dueNextWeek.length})</div>
    ${dueNextWeek.slice(0,8).map(t => `
      <div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px">
        <span style="color:#222;flex:1">${t.text}</span>
        <span style="color:#888;white-space:nowrap">${fmtDate(t.dueDate)}</span>
      </div>`).join('')}
  </div>` : ''}

  ${oldOpen.length > 0 ? `
  <!-- Procrastination Flags -->
  <div style="background:#fff8f2;border-radius:10px;padding:20px 24px;margin-bottom:16px;border:1px solid #f0d0b0">
    <div style="font-size:11px;font-weight:700;color:#c07a40;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">⏳ Sitting Longest — Review These</div>
    ${oldOpen.map(t => `
      <div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px">
        <span style="color:#222;flex:1">${t.text}</span>
        <span style="color:#c07a40;white-space:nowrap;font-weight:600">${daysDiff(t.createdAt, today)}d old</span>
      </div>`).join('')}
  </div>` : ''}

  <!-- Footer -->
  <div style="text-align:center;padding:12px">
    <a href="https://jacy-the-great.github.io/RPM-plan/RPM_Dashboard_Updated_1.html"
       style="display:inline-block;padding:10px 24px;background:#222;color:#fff;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">
      Open RPM Dashboard →
    </a>
    <div style="font-size:10px;color:#bbb;margin-top:10px">RPM Dashboard · Weekly review generated by GPT-4o Mini</div>
  </div>

</div>
</body>
</html>`;
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const cronSecret = process.env.CRON_SECRET;
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = req.headers['authorization'];
  if (cronSecret && !isVercelCron && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const today = todayAEST();
    console.log(`Generating weekly briefing for week ending ${today}`);

    const { tasks, log, categories } = await loadData();

    // Load priorities — passed as query param or body (sent from dashboard)
    let priorities = { quarter: '', month: '', weekly: [], threeToThrive: [] };
    try {
      const body = req.method === 'POST' ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) : {};
      if (body.priorities) priorities = { ...priorities, ...body.priorities };
    } catch (e) {}

    const weeklyData = computeWeekly(tasks, log, categories, today);
    console.log(`Weekly data: ${weeklyData.completedCount} completed, ${weeklyData.overdue.length} overdue`);

    const briefingText = await generateWeeklyBriefing(weeklyData, categories, priorities, today);
    console.log('Weekly AI briefing generated');

    const emailHtml = buildWeeklyEmail(briefingText, weeklyData, categories, today);

    const resend = new Resend(process.env.RESEND_API_KEY);
    const recipientEmail = process.env.RECIPIENT_EMAIL || 'jacymacnee1@gmail.com';

    const { data: emailData, error } = await resend.emails.send({
      from: 'RPM Dashboard <onboarding@resend.dev>',
      to: recipientEmail,
      subject: `📊 RPM Weekly Review — ${weeklyData.completedCount} done, ${weeklyData.overdue.length} overdue`,
      html: emailHtml,
    });

    if (error) throw new Error(JSON.stringify(error));
    console.log('Weekly email sent:', emailData?.id);

    res.status(200).json({
      success: true, emailId: emailData?.id, today,
      stats: { completed: weeklyData.completedCount, overdue: weeklyData.overdue.length },
    });

  } catch (err) {
    console.error('Weekly email error:', err);
    res.status(500).json({ error: err.message });
  }
};
