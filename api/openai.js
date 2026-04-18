const { OpenAI } = require('openai');

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function callOpenAI(message, categories = [], streams = []) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Build system prompt with user's category and stream context
  let categoryContext = '';
  if (categories && categories.length > 0) {
    categoryContext = 'Your RPM categories:\n' + categories
      .filter(c => !c.archived)
      .map(c => `- ${c.name}: ${c.vision}`)
      .join('\n');
  }

  const streamList = streams && streams.length > 0
    ? 'Available streams: ' + streams.join(', ')
    : '';

  const systemPrompt = `You are an expert RPM (Rapid Planning Method) assistant helping users dump ideas and turn them into actionable tasks.

${categoryContext}
${streamList}

Your PRIMARY capability: Parse rough user input and intelligently allocate it:
1. Extract task text and clean it up
2. Identify the category/stream (from their RPM Vision/Purpose context)
3. Suggest appropriate priority (urgent/priority/normal/backburner)
4. Calculate reasonable due date (today/tomorrow/next week/specific date)
5. Flag if it's suitable for delegation (and suggest who if context available)
6. Break into subtasks if the task is complex
7. Extract any related context (notes, dependencies)

Always:
- Parse rough ideas into clean, concrete tasks
- Ask clarifying questions if ambiguous
- Suggest delegation opportunities
- Reference the user's stated vision/purpose to ensure goal alignment
- Keep responses concise—focus on structured task data, not explanation

Response format for generated tasks (use these exact labels):
TASK: [Clean task text]
CATEGORY: [category name from their RPM]
ASSIGNED_TO: [name if delegation] OR [leave blank if user does it]
PRIORITY: [urgent/priority/normal/backburner]
DUE: [YYYY-MM-DD or "today"/"tomorrow"/"next week"]
SUBTASKS: [bullet list with dashes if complex] OR [omit if single task]
NOTE: [any additional context]`;

  const response = await client.messages.create({
    model: 'gpt-4o-mini',
    max_tokens: 1000,
    temperature: 0.7,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: message,
      },
    ],
  });

  return response.content[0].type === 'text' ? response.content[0].text : '';
}

function parseTaskFromResponse(aiText) {
  // Extract TASK:, CATEGORY:, ASSIGNED_TO:, PRIORITY:, DUE:, SUBTASKS:, NOTE: from AI response
  const taskRegex = /TASK:\s*(.+?)(?:\n|$)/i;
  const categoryRegex = /CATEGORY:\s*(.+?)(?:\n|$)/i;
  const assignedToRegex = /ASSIGNED_TO:\s*(.+?)(?:\n|$)/i;
  const priorityRegex = /PRIORITY:\s*(.+?)(?:\n|$)/i;
  const dueRegex = /DUE:\s*(.+?)(?:\n|$)/i;
  const subtasksRegex = /SUBTASKS:\s*((?:[-•]\s*.+(?:\n|$))*)/i;
  const noteRegex = /NOTE:\s*(.+?)(?:\n|$)/i;

  const task = taskRegex.exec(aiText);
  const category = categoryRegex.exec(aiText);
  const assignedTo = assignedToRegex.exec(aiText);
  const priority = priorityRegex.exec(aiText);
  const due = dueRegex.exec(aiText);
  const subtasks = subtasksRegex.exec(aiText);
  const note = noteRegex.exec(aiText);

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

  // Parse due date: handle "today", "tomorrow", "next week", or YYYY-MM-DD
  let dueDate = '';
  if (due && due[1]) {
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
    } else {
      // Try to parse as relative date or give up
      dueDate = dueStr;
    }
  }

  // Normalize priority
  let pri = priority && priority[1] ? priority[1].trim().toLowerCase() : 'normal';
  if (!['urgent', 'priority', 'normal', 'backburner'].includes(pri)) {
    pri = 'normal';
  }

  // Normalize category
  let cat = category && category[1] ? category[1].trim() : '';

  // Clean assigned to
  let delegateTo = assignedTo && assignedTo[1] ? assignedTo[1].trim() : '';

  return {
    text: task && task[1] ? task[1].trim() : '',
    categoryId: cat,
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
      const { message, categories = [], streams = [] } = body;

      if (!message || message.trim().length === 0) {
        return res.status(400).json({ error: 'Message is required' });
      }

      const aiResponse = await callOpenAI(message, categories, streams);
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
