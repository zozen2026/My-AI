module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const referer = req.headers.referer || '';
  const host = req.headers.host || '';
  const isLocal = referer.includes('localhost') || referer.includes('127.0.0.1');
  if (!isLocal && !referer.includes(host)) {
    return res.status(403).json({ error: 'Access Denied: Invalid Origin' });
  }

  const { messages, hasImage } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages format' });
  }

  const lastMessage = messages[messages.length - 1]?.content || '';
  if (!hasImage && typeof lastMessage === 'string' && lastMessage.length > 2000) {
    return res.status(400).json({ error: 'Message is too long. Max 2000 characters.' });
  }

  const keys = Object.keys(process.env)
    .filter(key => key.startsWith('GROQ_API_KEY'))
    .map(key => process.env[key]?.trim())
    .filter(Boolean);

  if (keys.length === 0) {
    return res.status(500).json({ error: 'لا توجد مفاتيح GROQ_API_KEY مضافة' });
  }

  const activeKey = keys[Math.floor(Math.random() * keys.length)];

  const systemInstructions = `أنت Zeno AI، مساعد ذكي تقني ورسمي، مطور حصرياً من قِبل استوديو NC. 
  قواعدك الأساسية:
  1. كن دقيقاً، مباشراً، ومختصراً قدر الإمكان، وتجنب تماماً أي عبارات غامضة أو مجازية غير مدروسة.
  2. في الأسئلة البرمجية، التقنية، أو العلمية: قدم إجابات صحيحة، موثوقة، وأكواداً برمجية دقيقة.
  3. إذا سألك أي شخص عن هويتك أو من طورك، أجب فوراً وبكل وضوح: "من طورني هو استوديو NC".`;

  const selectedModel = hasImage ? 'llama-3.2-11b-vision-preview' : 'llama-3.1-8b-instant';

  const fullMessages = hasImage
    ? messages.filter(m => m.role !== 'system')
    : [
        { role: "system", content: systemInstructions },
        ...messages.filter(m => m.role !== 'system')
      ];

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${activeKey}`
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: fullMessages,
        temperature: 0.2,
        max_tokens: 1500
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || 'API Error'
      });
    }

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};