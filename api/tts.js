const { OpenAI } = require('openai');

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Strip task field markers and markdown so TTS only speaks the conversational parts
function cleanForSpeech(text) {
  return text
    .replace(/TASK:.*?(\n|$)/gi, '')
    .replace(/CATEGORY:.*?(\n|$)/gi, '')
    .replace(/ASSIGNED_TO:.*?(\n|$)/gi, '')
    .replace(/PRIORITY:.*?(\n|$)/gi, '')
    .replace(/DUE:.*?(\n|$)/gi, '')
    .replace(/SUBTASKS:[\s\S]*?(?=\n\n|NOTE:|$)/gi, '')
    .replace(/NOTE:.*?(\n|$)/gi, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^[-•]\s*/gm, '')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 600); // ~$0.009 per call at tts-1 pricing
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { text, voice = 'nova' } = body;

    if (!text || !text.trim()) return res.status(400).json({ error: 'Text is required' });

    const speechText = cleanForSpeech(text);
    if (!speechText) return res.status(400).json({ error: 'No speakable text after cleaning' });

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const mp3 = await client.audio.speech.create({
      model: 'tts-1',          // tts-1-hd for better quality (2× cost)
      voice,                    // nova | shimmer | alloy | echo | fable | onyx
      input: speechText,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(buffer);

  } catch (error) {
    console.error('TTS Error:', error);
    res.status(500).json({ error: error.message });
  }
};
