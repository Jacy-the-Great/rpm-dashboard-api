const { google } = require('googleapis');

// Set CORS headers
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Initialize Sheets API
async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

// Read data from sheets
async function readSheets() {
  const sheets = await getSheetsClient();
  const spreadsheetId = '1SK3hsYiff-P3KK96k7cEiFhORB25BROFzS5ADE3XACM';

  // Read Tasks sheet
  const tasksResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Tasks!A:H',
  });

  // Read Log sheet
  const logResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Log!A:E',
  });

  const taskData = tasksResponse.data.values || [];
  const logData = logResponse.data.values || [];

  // Convert to JSON (skip header row)
  const tasks = taskData.slice(1).map(row => ({
    id: row[0],
    stream: row[1],
    text: row[2],
    pri: row[3],
    dueDate: row[4],
    note: row[5],
    done: row[6] === true || row[6] === 'TRUE',
    subs: row[7] ? JSON.parse(row[7]) : []
  }));

  const log = logData.slice(1).map(row => ({
    taskId: row[0],
    completedAt: row[1],
    dueDate: row[2],
    daysLate: row[3],
    weekStart: row[4]
  }));

  return { tasks, log };
}

// Write data to sheets
async function writeSheets(tasks, log) {
  const sheets = await getSheetsClient();
  const spreadsheetId = '1SK3hsYiff-P3KK96k7cEiFhORB25BROFzS5ADE3XACM';

  // Prepare Tasks data
  const tasksData = [
    ['id', 'stream', 'text', 'pri', 'dueDate', 'note', 'done', 'subs'],
    ...tasks.map(t => [
      t.id,
      t.stream,
      t.text,
      t.pri,
      t.dueDate,
      t.note,
      t.done,
      JSON.stringify(t.subs || [])
    ])
  ];

  // Prepare Log data
  const logData = [
    ['taskId', 'completedAt', 'dueDate', 'daysLate', 'weekStart'],
    ...log.map(entry => [
      entry.taskId,
      entry.completedAt,
      entry.dueDate,
      entry.daysLate,
      entry.weekStart
    ])
  ];

  // Clear and write Tasks
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: 'Tasks!A:H',
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Tasks!A1',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: tasksData
    }
  });

  // Clear and write Log
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: 'Log!A:E',
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Log!A1',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: logData
    }
  });
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    if (req.method === 'GET') {
      const data = await readSheets();
      res.status(200).json(data);
    } else if (req.method === 'POST') {
      const { tasks, log } = req.body;
      await writeSheets(tasks, log);
      res.status(200).json({ status: 'ok' });
    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
}
