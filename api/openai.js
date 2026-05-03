const { OpenAI } = require('openai');

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function callOpenAI(message, categories = [], streams = [], tasks = [], priorities = {}) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Build system prompt with user's category and stream context
  let categoryContext = '';
  if (categories && categories.length > 0) {
    categoryContext = 'Your RPM categories:\n' + categories
      .filter(c => !c.archived)
      .map(c => `- ${c.name}${c.vision ? ': ' + c.vision : ''}`)
      .join('\n');
  }

  const streamList = streams && streams.length > 0
    ? 'Available streams: ' + streams.join(', ')
    : '';

  const overdueTasks = (tasks || []).filter(t => !t.done && t.dueDate && t.dueDate < new Date().toISOString().slice(0,10));
  const urgentTasks = (tasks || []).filter(t => !t.done && (t.pri === 'urgent' || t.pri === 'priority'));
  const taskSummary = tasks && tasks.length > 0 ? `
Current task context:
- ${tasks.filter(t=>!t.done).length} open tasks, ${overdueTasks.length} overdue
- Urgent/priority tasks: ${urgentTasks.slice(0,5).map(t=>t.text).join(', ') || 'none'}` : '';

  const priorityContext = priorities && (priorities.quarter || priorities.monthly) ? `
Strategic priorities:
${priorities.quarter ? '- Quarter: ' + priorities.quarter : ''}
${priorities.month ? '- Month: ' + priorities.month : ''}
${priorities.weekly?.length ? '- This week: ' + priorities.weekly.join(', ') : ''}` : '';

  const systemPrompt = `You are Jacy's RPM (Rapid Planning Method) strategic assistant. You have two modes:

**MODE 1 — TASK CREATION**: When the user describes a task to create, output it in structured format.
**MODE 2 — STRATEGIC ADVICE**: When the user asks a question, give sharp, concise strategic advice. Analyze their tasks and priorities. Be direct and insightful.

${categoryContext}
${streamList}
${taskSummary}
${priorityContext}

TASK CREATION rules:
- ONLY include ASSIGNED_TO if the user explicitly names someone to delegate to
- ONLY include DUE if the user explicitly mentions a due date or timeframe
- ONLY include PRIORITY if the user explicitly states urgency
- Do NOT suggest delegation unless asked
- Do NOT invent due dates
- Keep task text clean and concise

Task format (only include fields that are explicitly stated):
TASK: [clean task text]
STREAM: [matching stream/category from their plan, or omit if unclear]
PRIORITY: [urgent/priority/normal/backburner — only if user stated this]
DUE: [YYYY-MM-DD — only if user stated a date/timeframe]
ASSIGNED_TO: [person name — only if user said to delegate to someone]
SUBTASKS:
- [subtask if complex]
NOTE: [any extra context]

STRATEGIC ADVICE rules:
- For questions like "what should I focus on?", "how am I tracking?", "what am I neglecting?" — give direct advice
- Reference their actual task data and strategic priorities
- Be a sharp business partner, not a life coach
- Keep it under 150 words unless the question warrants more`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1000,
    temperature: 0.7,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ],
  });

  return response.choices[0].message.content || '';
}

function parseTaskFromResponse(aiText) {
  // Extract TASK:, ASSIGNED_TO:, PRIORITY:, DUE:, SUBTASKS:, NOTE: from AI response
  const taskRegex = /TASK:\s*(.+?)(?:\n|$)/i;
  const assignedToRegex = /ASSIGNED_TO:\s*(.+?)(?:\n|$)/i;
  const priorityRegex = /PRIORITY:\s*(.+?)(?:\n|$)/i;
  const dueRegex = /DUE:\s*(.+?)(?:\n|$)/i;
  const subtasksRegex = /SUBTASKS:\s*((?:[-•]\s*.+(?:\n|$))*)/i;
  const noteRegex = /NOTE:\s*(.+?)(?:\n|$)/i;
  const streamRegex = /STREAM:\s*(.+?)(?:\n|$)/i;

  const task = taskRegex.exec(aiText);
  const assignedTo = assignedToRegex.exec(aiText);
  const priority = priorityRegex.exec(aiText);
  const due = dueRegex.exec(aiText);
  const subtasks = subtasksRegex.exec(aiText);
  const note = noteRegex.exec(aiText);
  const stream = streamRegex.exec(aiText);

  // Parse subtasks: extract bullet points
  let subs = [];
  if (subtasks && subtasks[1]) {
    subs = subtasks[1]
      .split('\n')
      .map(line => line.replace(/^[-•]\s*/, '').trim())
      .filter(line => line.length > 0)
      .map(text => ({
        id: Math.random().toString(36).substr(2, 9),
        text,
        done: false,
        dueDate: '',
        createdAt: new Date().toISOString(),
      }));
  }

  // Parse due date — skip placeholders
  let dueDate = '';
  if (due && due[1] && !/leave blank|not specified|n\/a|none|tbd/i.test(due[1])) {
    const dueStr = due[1].trim().toLowerCase();
    const today = new Date();
    if (dueStr === 'today') {
      dueDate = today.toISOString().split('T')[0];
    } else if (dueStr === 'tomorrow') {
      today.setDate(today.getDate() + 1);
      dueDate = today.toISOString().split('T')[0];
    } else if (dueStr === 'next week') {
      today.setDate(today.getDate() + 7);
      dueDate = today.toISOString().split('T')[0];
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(dueStr)) {
      dueDate = dueStr;
    }
  }

  // Normalize priority
  let pri = priority && priority[1] ? priority[1].trim().toLowerCase() : 'normal';
  if (!['urgent', 'priority', 'normal', 'backburner'].includes(pri)) {
    pri = 'normal';
  }

  // Clean assigned to — skip placeholders
  let delegateTo = assignedTo && assignedTo[1] && !/leave blank|n\/a|none/i.test(assignedTo[1])
    ? assignedTo[1].trim() : '';

  return {
    text: task && task[1] ? task[1].trim() : '',
    stream: stream && stream[1] ? stream[1].trim() : '',
    priority: pri,
    dueDate,
    subs,
    note: note && note[1] ? note[1].trim() : '',
    delegateIntent: delegateTo.length > 0,
    delegatedTo: delegateTo,
  };
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { message, categories = [], streams = [], tasks = [], priorities = {} } = body;

      if (!message || message.trim().length === 0) {
        return res.status(400).json({ error: 'Message is required' });
      }

      const aiResponse = await callOpenAI(message, categories, streams, tasks, priorities);
      const taskData = parseTaskFromResponse(aiResponse);

      res.status(200).json({
        response: aiResponse,
        taskData: taskData.text ? taskData : null,
      });
    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('OpenAI API Error:', error);
    res.status(500).json({ error: error.message });
  }
};
