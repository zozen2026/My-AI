module.exports = async function handler(req, res) {
  // السماح بطلبات OPTIONS الخاصة بالمتصفحات (CORS Preflight)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 1. حماية مرنة تعمل على جميع الهواتف وتطبيقات PWA بدون حظر المتصفحات التي تخفي Referer
  const referer = req.headers.referer || '';
  const origin = req.headers.origin || '';
  const host = req.headers.host || '';
  const isLocal = referer.includes('localhost') || referer.includes('127.0.0.1') || origin.includes('localhost');

  if (!isLocal && referer && !referer.includes(host) && origin && !origin.includes(host)) {
    return res.status(403).json({ error: 'Access Denied: Invalid Origin' });
  }

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages format' });
  }

  // فحص آخر رسالة لمعرفة هل المستخدم يطلب رسم صورة أم محادثة نصية
  const lastUserMessage = messages[messages.length - 1]?.content?.trim() || '';
  const imageTriggers = ['/رسم', '/image', 'ارسم لي', 'ارسم', 'صمم صورة', 'ولد صورة'];
  const isImageRequest = imageTriggers.some(trigger => lastUserMessage.startsWith(trigger));

  // ==========================================
  // المسار الأول: توليد الصور (Pollinations Image - مجاني 100%)
  // ==========================================
  if (isImageRequest) {
    let cleanPrompt = lastUserMessage;
    for (const trigger of imageTriggers) {
      if (cleanPrompt.startsWith(trigger)) {
        cleanPrompt = cleanPrompt.replace(trigger, '').trim();
        break;
      }
    }

    if (!cleanPrompt) {
      return res.status(200).json({
        choices: [{
          message: {
            role: 'assistant',
            content: 'اكتب وصف الصورة بعد الأمر، مثلاً: `/رسم رائد فضاء يشرب قهوة على القمر`'
          }
        }]
      });
    }

    const seed = Math.floor(Math.random() * 1000000);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=1024&height=1024&nologo=true&seed=${seed}`;

    return res.status(200).json({
      choices: [{
        message: {
          role: 'assistant',
          content: `تفضل، هذه صورتك:\n\n![${cleanPrompt}](${imageUrl})\n\n[⬇️ تحميل الصورة بجودة عالية](${imageUrl})`
        }
      }]
    });
  }

  // ==========================================
  // المسار الثاني: المحادثة النصية (Pollinations أساسي + Groq احتياطي)
  // ==========================================
  const systemInstructions = `أنت Zeno AI، مساعد ذكي تقني ومبتكر مطور حصرياً من قِبل استوديو NC. 
قواعدك الأساسية:
1. تحدث دائماً باللهجة العامية الدارجة والمريحة المناسبة لأسلوب المستخدم.
2. في البرمجة: ضع الأكواد داخل علامات الكود الثلاثية (\`\`\`).
3. إذا سألك أحد عن مطورك أجب بكل وضوح: "من طورني هو استوديو NC".`;

  const fullMessages = [
    { role: "system", content: systemInstructions },
    ...messages.filter(m => m.role !== 'system')
  ];

  // المحاولة الأولى: Pollinations (مجاني 100% بدون توكنز)
  try {
    const pollinationsRes = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai',
        messages: fullMessages,
        seed: Math.floor(Math.random() * 100000)
      })
    });

    if (pollinationsRes.ok) {
      const data = await pollinationsRes.json();
      if (data && data.choices && data.choices.length > 0) {
        return res.status(200).json(data);
      }
    }
  } catch (err) {
    // في حال تعثر Pollinations، سينتقل بصمت للخطة الاحتياطية بالأسفل
  }

  // المحاولة الثانية (الاحتياطية): Groq API في حال ازدحام السيرفر الأول
  const keys = Object.keys(process.env)
    .filter(key => key.startsWith('GROQ_API_KEY'))
    .map(key => process.env[key]?.trim())
    .filter(Boolean);

  if (keys.length > 0) {
    const activeKey = keys[Math.floor(Math.random() * keys.length)];
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${activeKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: fullMessages,
          temperature: 0.6,
          max_tokens: 900
        })
      });

      const groqData = await groqRes.json();
      if (groqRes.ok) {
        return res.status(200).json(groqData);
      }
    } catch (groqErr) {
      // تجاهل الخطأ والوصول لرسالة الخطأ الموحدة بالأسفل
    }
  }

  return res.status(503).json({
    error: 'الخادم مشغول حالياً، يرجى المحاولة مرة أخرى بعد ثوانٍ.'
  });
};