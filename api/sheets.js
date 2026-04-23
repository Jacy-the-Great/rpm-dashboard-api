const { google } = require('googleapis');

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function getSheetsClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) throw new Error('GOOGLE_SERVICE_ACCOUNT not set');
  let credentials;
  try {
    credentials = typeof process.env.GOOGLE_SERVICE_ACCOUNT === 'string'
      ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT)
      : process.env.GOOGLE_SERVICE_ACCOUNT;
  } catch (e) { throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT format'); }
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

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
  } catch (e) { console.error(`Failed to ensure sheet ${sheetTitle}:`, e.message); }
}

function safeJson(str) { try { return JSON.parse(str); } catch { return []; } }
function toBool(v) { return v === true || v === 'TRUE' || v === 'true'; }

const PRIMARY_ID   = '1SK3hsYiff-P3KK96k7cEiFhORB25BROFzS5ADE3XACM'; // original master
const BACKUP_ID    = process.env.BACKUP_SHEET_ID || '1YlMq2y2HjJKkuWCmFVtCUH0mL0mROrb4VDTlPIO6dHQ'; // jacymacnee1 backup

async function readSheets() {
  const sheets = await getSheetsClient();
  const spreadsheetId = PRIMARY_ID;

  // Tasks A:N — 14 columns (Wave 2 adds delegateIntent col M, delegatedTo col N)
  const tasksRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Tasks!A:N' });

  // Log A:F — 6 columns (Wave 2 adds delegatedTo col F)
  const logRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Log!A:F' });

  // Categories A:H
  let categoriesData = [];
  try {
    const catRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Categories!A:H' });
    categoriesData = catRes.data.values || [];
  } catch (e) { console.log('Categories sheet not found'); }

  const taskData = tasksRes.data.values || [];
  const logData  = logRes.data.values   || [];

  // Tasks: id, stream, text, pri, dueDate, note, done, subs, categoryId,
  //        createdAt, isDailyVictory, isWeeklyFocus, delegateIntent, delegatedTo
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
    delegateIntent: toBool(row[12]),
    delegatedTo:    row[13] || '',
  }));

  // Log: taskId, completedAt, dueDate, daysLate, weekStart, delegatedTo
  const log = logData.slice(1).map(row => ({
    taskId:      row[0] || '',
    completedAt: row[1] || '',
    dueDate:     row[2] || '',
    daysLate:    row[3] !== undefined ? row[3] : null,
    weekStart:   row[4] || '',
    delegatedTo: row[5] || '',
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

function buildSheetData(tasks, log, categories) {
  const tasksData = [
    ['id','stream','text','pri','dueDate','note','done','subs','categoryId','createdAt','isDailyVictory','isWeeklyFocus','delegateIntent','delegatedTo'],
    ...(tasks || []).map(t => [
      t.id || '', t.stream || '', t.text || '', t.pri || 'normal',
      t.dueDate || '', t.note || '', t.done || false,
      JSON.stringify(t.subs || []),
      t.categoryId || '', t.createdAt || '',
      t.isDailyVictory || false, t.isWeeklyFocus || false,
      t.delegateIntent || false, t.delegatedTo || '',
    ])
  ];
  const logData = [
    ['taskId','completedAt','dueDate','daysLate','weekStart','delegatedTo'],
    ...(log || []).map(e => [
      e.taskId || '', e.completedAt || '', e.dueDate || '',
      e.daysLate !== null && e.daysLate !== undefined ? e.daysLate : '',
      e.weekStart || '', e.delegatedTo || '',
    ])
  ];
  const categoriesData = [
    ['id','name','color','vision','purpose','result','createdAt','archived'],
    ...(categories || []).map(c => [
      c.id || '', c.name || '', c.color || '#888',
      c.vision || '', c.purpose || '', c.result || '',
      c.createdAt || '', c.archived || false,
    ])
  ];
  return { tasksData, logData, categoriesData };
}

async function writeToSheet(sheets, spreadsheetId, tasksData, logData, categoriesData) {
  await ensureSheetExists(sheets, spreadsheetId, 'Tasks');
  await ensureSheetExists(sheets, spreadsheetId, 'Log');
  await ensureSheetExists(sheets, spreadsheetId, 'Categories');
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'Tasks!A:N' });
  await sheets.spreadsheets.values.append({ spreadsheetId, range: 'Tasks!A1', valueInputOption: 'USER_ENTERED', resource: { values: tasksData } });
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'Log!A:F' });
  await sheets.spreadsheets.values.append({ spreadsheetId, range: 'Log!A1', valueInputOption: 'USER_ENTERED', resource: { values: logData } });
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'Categories!A:H' });
  await sheets.spreadsheets.values.append({ spreadsheetId, range: 'Categories!A1', valueInputOption: 'USER_ENTERED', resource: { values: categoriesData } });
}

async function writeSheets(tasks, log, categories) {
  const sheets = await getSheetsClient();
  const { tasksData, logData, categoriesData } = buildSheetData(tasks, log, categories);

  // Write to primary — awaited (blocks response)
  await writeToSheet(sheets, PRIMARY_ID, tasksData, logData, categoriesData);
  console.log('Primary sheet written:', PRIMARY_ID);

  // Write to backup — fire and forget (never blocks or fails the main request)
  if (BACKUP_ID) {
    writeToSheet(sheets, BACKUP_ID, tasksData, logData, categoriesData)
      .then(() => console.log('Backup sheet written:', BACKUP_ID))
      .catch(e => console.warn('Backup write failed (non-critical):', e.message));
  }
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  try {
    if (req.method === 'GET') {
      res.status(200).json(await readSheets());
    } else if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      await writeSheets(body.tasks, body.log, body.categories);
      res.status(200).json({ status: 'ok' });
    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
};
