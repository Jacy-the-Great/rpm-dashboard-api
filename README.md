# RPM Dashboard API

A simple backend for reading and writing to Google Sheets, deployed on Vercel.

## Setup

1. **Deploy to Vercel**
   - Go to https://vercel.com
   - Click "New Project"
   - Connect your GitHub account (or upload this folder)
   - Click "Import"

2. **Add Environment Variable**
   - In Vercel project settings, go to **Environment Variables**
   - Create a new variable: `GOOGLE_SERVICE_ACCOUNT`
   - Paste the entire contents of the JSON file you downloaded: `rpm-dashboard-492205-df1ddfa0d4ae.json`
   - Click "Save"
   - Redeploy the project

3. **Update Your Dashboard**
   - Replace the Apps Script URL with your Vercel deployment URL
   - Example: `https://your-vercel-project.vercel.app/api/sheets`

## API Endpoints

### GET /api/sheets
Returns Tasks and Log data from the Google Sheet.

**Response:**
```json
{
  "tasks": [...],
  "log": [...]
}
```

### POST /api/sheets
Writes Tasks and Log data to the Google Sheet.

**Request body:**
```json
{
  "tasks": [...],
  "log": [...]
}
```

## Local Development

```bash
npm install
npm run dev
```

Then access: http://localhost:3000/api/sheets
