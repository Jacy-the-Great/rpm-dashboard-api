const { google } = require('googleapis');

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function getSheetsClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT environment variable not set');
  }
  let credentials;
  try {
    credentials = typeof process.env.GOOGLE_SERVICE_ACCOUNT === 'string'
      ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT)
      : process.env.GOOGLE_SERVICE_ACCOUNT;
  } catch (e) {
    throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT format');
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Ensure a sheet tab exists; create it if not
async function ensureSheetExists(sheets, spreadsheetId, sheetTitle) {
  try {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const exists = spreadsheet.data.sheets.some(s => s.properties.title === sheetTitle);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: { requests: [{ addSheet: { properties: { title: sheetTitle } } }] }
      });
      console.log(`Created sheet tab: ${sheetTitle}`);
    }
  } catch (e) {
    console.error(`Failed to ensure sheet ${sheetTitle} exists:`, e.message);
  }
}

function safeJson(str) {
  try { return JSON.parse(str); } catch { return []; }
}

function toBool(val) {
  return val === true || val === 'TRUE' || val === 'true';
}

async function readSheets() {
  const sheets = await getSheetsClient();
  const spreadsheetId = '1SK3hsYiff-P3KK96k7cEiFhORB25BROFzS5ADE3XACM';

  // Tasks — expanded to A:L (12 columns)
  const tasksResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Tasks!A:L',
  });

  // Log — unchanged A:E
  const logResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Log!A:E',
  });

  // Categories — new sheet, may not exist yet
  let categoriesData = [];
  try {
    const catResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Categories!A:H',
    });
    categoriesData = catResponse.data.values || [];
  } catch (e) {
    console.log('Categories sheet not found, returning empty array');
  }

  const taskData  = tasksResponse.data.values || [];
  const logData   = logResponse.data.values   || [];

  // Tasks: id, stream, text, pri, dueDate, note, done, subs(JSON),
  //        categoryId, createdAt, isDailyVictory, isWeeklyFocus
  const tasks = taskData.slice(1).map(row => ({
    id:             row[0]  || '',
    stream:         row[1]  || '',
    text:           row[2]  || '',
    pri:            row[3]  || 'normal',
    dueDate:        row[4]  || '',
    note:           row[5]  || '',
    done:           toBool(row[6]),
    subs:           row[7]  ? safeJson(row[7]) : [],
    categoryId:     row[8]  || '',
    createdAt:      row[9]  || '',
    isDailyVictory: toBool(row[10]),
    isWeeklyFocus:  toBool(row[11]),
  }));

  const log = logData.slice(1).map(row => ({
    taskId:      row[0] || '',
    completedAt: row[1] || '',
    dueDate:     row[2] || '',
    daysLate:    row[3] !== undefined ? row[3] : null,
    weekStart:   row[4] || '',
  }));

  // Categories: id, name, color, vision, purpose, result, createdAt, archived
  const categories = categoriesData.slice(1).map(row => ({
    id:        row[0] || '',
    name:      row[1] || '',
    color:     row[2] || '#888',
    vision:    row[3] || '',
    purpose:   row[4] || '',
    result:    row[5] || '',
    createdAt: row[6] || '',
    archived:  toBool(row[7]),
  }));

  return { tasks, log, categories };
}

async function writeSheets(tasks, log, categories) {
  const sheets = await getSheetsClient();
  const spreadsheetId = '1SK3hsYiff-P3KK96k7cEiFhORB25BROFzS5ADE3XACM';

  // Ensure Categories sheet exists before writing
  await ensureSheetExists(sheets, spreadsheetId, 'Categories');

  // Tasks data — 12 columns
  const tasksData = [
    ['id','stream','text','pri','dueDate','note','done','subs','categoryId','createdAt','isDailyVictory','isWeeklyFocus'],
    ...(tasks || []).map(t => [
      t.id        || '',
      t.stream    || '',
      t.text      || '',
      t.pri       || 'normal',
      t.dueDate   || '',
      t.note      || '',
      t.done      || false,
      JSON.stringify(t.subs || []),
      t.categoryId     || '',
      t.createdAt      || '',
      t.isDailyVictory || false,
      t.isWeeklyFocus  || false,
    ])
  ];

  // Log data — 5 columns (unchanged)
  const logData = [
    ['taskId','completedAt','dueDate','daysLate','weekStart'],
    ...(log || []).map(e => [
      e.taskId      || '',
      e.completedAt || '',
      e.dueDate     || '',
      e.daysLate    !== null && e.daysLate !== undefined ? e.daysLate : '',
      e.weekStart   || '',
    ])
  ];

  // Categories data — 8 columns
  const categoriesData = [
    ['id','name','color','vision','purpose','result','createdAt','archived'],
    ...(categories || []).map(c => [
      c.id        || '',
      c.name      || '',
      c.color     || '#888',
      c.vision    || '',
      c.purpose   || '',
      c.result    || '',
      c.createdAt || '',
      c.archived  || false,
    ])
  ];

  // Clear and write Tasks (expanded range)
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'Tasks!A:L' });
  await sheets.spreadsheets.values.append({
    spreadsheetId, range: 'Tasks!A1', valueInputOption: 'USER_ENTERED',
    resource: { values: tasksData }
  });

  // Clear and write Log
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'Log!A:E' });
  await sheets.spreadsheets.values.append({
    spreadsheetId, range: 'Log!A1', valueInputOption: 'USER_ENTERED',
    resource: { values: logData }
  });

  // Clear and write Categories
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'Categories!A:H' });
  await sheets.spreadsheets.values.append({
    spreadsheetId, range: 'Categories!A1', valueInputOption: 'USER_ENTERED',
    resource: { values: categoriesData }
  });
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    if (req.method === 'GET') {
      const data = await readSheets();
      res.status(200).json(data);
    } else if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { tasks, log, categories } = body;
      await writeSheets(tasks, log, categories);
      res.status(200).json({ status: 'ok' });
    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
};
