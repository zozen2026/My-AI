module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // حماية مرنة تعمل على جميع الهواتف وتطبيقات PWA
  const referer = req.headers.referer || '';
  const origin = req.headers.origin || '';
  const host = req.headers.host || '';
  const isLocal = referer.includes('localhost') || referer.includes('127.0.0.1') || origin.includes('localhost');

  if (!isLocal && referer && !referer.includes(host) && origin && !origin.includes(host)) {
    return res.status(403).json({ error: 'Access Denied: Invalid Origin' });
  }

  const { messages, model: selectedModel, imageBase64 } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages format' });
  }

  // جلب جميع مفاتيح GROQ_API_KEY المضافة في الاستضافة
  const keys = Object.keys(process.env)
    .filter(key => key.startsWith('GROQ_API_KEY'))
    .map(key => process.env[key]?.trim())
    .filter(Boolean);

  if (keys.length === 0) {
    return res.status(500).json({ error: 'لا توجد مفاتيح GROQ_API_KEY مضافة في إعدادات السيرفر' });
  }

  const shuffledKeys = keys.sort(() => Math.random() - 0.5);

  const visionModels = [
    'meta-llama/llama-4-scout-17b-16e-instruct'
  ];

  const defaultModels = [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'openai/gpt-oss-120b',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'qwen/qwen3-32b'
  ];

  let modelsToTry = imageBase64
    ? [...visionModels, ...defaultModels.filter(m => !visionModels.includes(m))]
    : [...defaultModels];

  if (selectedModel && selectedModel !== 'auto') {
    modelsToTry = [selectedModel, ...modelsToTry.filter(m => m !== selectedModel)];
  }

  const systemInstructions = `You are Zeno AI, an intelligent, creative technical AI assistant developed exclusively by NC Studio (استوديو NC).
Core rules:
1. Always respond in the exact same language as the user's latest message (Arabic, English, French, Spanish, Turkish, Kurdish, German, etc.), using a natural, friendly, conversational tone in that language.
2. When an image is attached, examine it accurately and answer the user's question about it.
3. For programming, always place code inside triple backticks (\`\`\`).
4. If asked who developed you, reply clearly in the user's language that you were developed by NC Studio ("من طورني هو استوديو NC" in Arabic, or "I was developed by NC Studio" in English).`;

  const recentMessages = messages.filter(m => m.role !== 'system').slice(-6);

  // إرفاق الصورة في آخر رسالة للمستخدم إذا كانت موجودة
  if (imageBase64 && recentMessages.length > 0) {
    const lastIdx = recentMessages.length - 1;
    const lastMsg = recentMessages[lastIdx];
    const textContent = typeof lastMsg.content === 'string'
      ? lastMsg.content
      : 'Describe and analyze this image.';

    recentMessages[lastIdx] = {
      ...lastMsg,
      content: [
        { type: 'text', text: textContent },
        { type: 'image_url', image_url: { url: imageBase64 } }
      ]
    };
  }

  const fullMessages = [
    { role: 'system', content: systemInstructions },
    ...recentMessages
  ];

  let lastGroqError = '';

  for (const apiKey of shuffledKeys) {
    for (const modelName of modelsToTry) {
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: modelName,
            messages: fullMessages,
            temperature: 0.6,
            max_tokens: 900
          })
        });

        const data = await response.json();

        if (response.ok && data.choices && data.choices.length > 0) {
          return res.status(200).json(data);
        } else {
          lastGroqError = `${modelName}: ${data.error?.message || response.status}`;
        }
      } catch (err) {
        lastGroqError = err.message;
      }
    }
  }

  return res.status(503).json({
    error: `فشل الاتصال: ${lastGroqError}`
  });
};