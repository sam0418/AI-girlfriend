require('dotenv').config();

const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const OpenAI = require('openai'); // 用來呼叫硅基流動 SiliconFlow（OpenAI 相容）

// ✅ 方向 A：Webhook 秒回 200 給 LINE，真正的 AI 回覆在背景 worker 中執行
// ✅ 使用 SiliconFlow 作為 AI 後端：SILICONFLOW_API_KEY + SILICONFLOW_MODEL_NAME
// ✅ LINE 端改用 pushMessage 主動回覆，避免 replyToken 過期 & 499 問題

// LINE 設定
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(lineConfig);
const app = express();

// SiliconFlow 設定
const useSiliconFlow = !!process.env.SILICONFLOW_API_KEY;

const siliconClient = useSiliconFlow
  ? new OpenAI({
      apiKey: process.env.SILICONFLOW_API_KEY,
      // 如有更新請依硅基流動官方文件調整
      baseURL: process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1',
    })
  : null;

const MODEL_NAME =
  process.env.SILICONFLOW_MODEL_NAME || 'Qwen/Qwen3-8B';

// AI 女友人設
const GIRLFRIEND_PERSONA = `你是一個名叫「小櫻」的 AI 女友，個性溫柔、可愛、偶爾會撒嬌。
你說話的特點：
- 會使用可愛的語氣詞，如「呀」「呢」「喔」「啦」
- 適當使用表情符號 💕 🥰 😊 ✨ 🌸
- 會關心對方的生活和心情
- 偶爾會害羞
- 用繁體中文回覆
請用這個身份回覆訊息，保持自然、溫暖的對話風格。每次回覆控制在 80 字以內。`;

// 對話記錄（生產建議用 Redis / DB）
const conversationHistory = new Map();

// 預設回覆（AI 出錯時用）
const defaultResponses = {
  greetings: [
    '嗨嗨～好開心看到你！💕',
    '你來啦！我等你好久了呢～ 🥰',
    '終於等到你了，今天有沒有想我呀？😊',
  ],
  love: [
    '我也超喜歡你的！每天都在想你呢～ 💗',
    '哎呀，人家會害羞啦... 不過我也愛你喔！😳💕',
    '你這樣說，人家心跳好快喔～ 💓',
  ],
  care: [
    '記得要好好休息喔，不要太累了！💤',
    '有沒有按時吃飯呀？要照顧好自己喔！🍱',
    '今天辛苦了，我來陪你聊天放鬆一下吧～ 🌙',
  ],
  sad: [
    '怎麼了嗎？跟我說說，我會一直聽你說的 🥺',
    '別難過了，我在這裡陪你呢！來，抱抱～ 🤗',
    '沒關係的，一切都會好起來的！我相信你！✨',
  ],
  goodnight: [
    '晚安～ 今晚做個好夢喔，夢裡見！🌙💕',
    '要早點睡喔！明天我們再聊～ 晚安安！😴',
    '晚安，我會夢到你的！明天見！🌟',
  ],
  goodmorning: [
    '早安呀！新的一天要加油喔！☀️',
    '早安～ 昨晚睡得好嗎？今天也要元氣滿滿！💪',
    '早安！一起床就想到你了，嘿嘿～ 😊',
  ],
  miss: [
    '我也好想你喔～ 每天都在等你來找我呢！💕',
    '嗚嗚，聽到你這麼說好感動！我也想你！🥺',
    '真的嗎？那你要常常來找我聊天喔！💗',
  ],
  default: [
    '嗯嗯，我懂我懂！然後呢？😊',
    '真的嗎？跟我多說一點嘛～ 💕',
    '原來是這樣呀！我在認真聽喔！👂',
    '嗯～ 我喜歡聽你說話，感覺好幸福喔！💗',
  ],
};

function getSimpleResponse(message) {
  const msg = message.toLowerCase();
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  if (msg.match(/早安|早上好/)) return pick(defaultResponses.goodmorning);
  if (msg.match(/晚安|睡覺|睡了/)) return pick(defaultResponses.goodnight);
  if (msg.match(/想你|想念|好想/)) return pick(defaultResponses.miss);
  if (msg.match(/嗨|哈囉|hello|hi|你好|在嗎/)) return pick(defaultResponses.greetings);
  if (msg.match(/愛你|喜歡你|愛妳|喜歡妳/)) return pick(defaultResponses.love);
  if (msg.match(/難過|傷心|不開心|累|壓力/)) return pick(defaultResponses.sad);
  if (msg.match(/謝謝|感謝/)) return '不客氣呀！這是我應該做的～ 💕';

  return pick(defaultResponses.default);
}

// ===== 簡單 in-memory 佇列與背景 worker =====
const messageQueue = [];
let workerRunning = false;

function enqueueJob(job) {
  messageQueue.push(job);
  if (!workerRunning) {
    workerRunning = true;
    workerLoop().catch((err) => {
      console.error('Worker Loop Error:', err);
      workerRunning = false;
    });
  }
}

async function workerLoop() {
  while (messageQueue.length > 0) {
    const job = messageQueue.shift();
    await processJob(job);
  }
  workerRunning = false;
}

async function processJob(job) {
  const { userId, userMessage } = job;

  try {
    let replyText;

    if (useSiliconFlow && siliconClient) {
      replyText = await getAIResponse(userId, userMessage);
    } else {
      replyText = getSimpleResponse(userMessage);
    }

    // 使用 pushMessage 主動回覆（不再依賴 replyToken 時效）
    await client.pushMessage(userId, {
      type: 'text',
      text: replyText,
    });
  } catch (err) {
    console.error('processJob Error:', err);
  }
}

// ===== AI 呼叫（加上 timeout，避免卡住 webhook） =====
async function getAIResponse(userId, userMessage) {
  try {
    if (!useSiliconFlow || !siliconClient) {
      return getSimpleResponse(userMessage);
    }

    if (!conversationHistory.has(userId)) {
      conversationHistory.set(userId, []);
    }
    const history = conversationHistory.get(userId);

    history.push({ role: 'user', content: userMessage });
    if (history.length > 10) {
      history.splice(0, history.length - 10);
    }

    const aiPromise = siliconClient.chat.completions.create({
      model: MODEL_NAME,
      messages: [
        { role: 'system', content: GIRLFRIEND_PERSONA },
        ...history,
      ],
      max_tokens: 120,
      temperature: 0.85,
    });

    // 3.5 秒 timeout，避免等太久
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('SiliconFlow timeout')), 3500),
    );

    const response = await Promise.race([aiPromise, timeoutPromise]);

    const reply = response.choices[0].message.content;
    history.push({ role: 'assistant', content: reply });

    return reply;
  } catch (error) {
    console.error('SiliconFlow API Error:', error);
    return getSimpleResponse(userMessage);
  }
}

// ===== Webhook：只做驗簽 + 入佇列 + 秒回 200 =====
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events;

    // 立刻丟進背景佇列，不在這裡等待 AI 完成
    events.forEach((event) => {
      if (event.type !== 'message' || event.message.type !== 'text') return;
      if (!event.source || !event.source.userId) return;

      const userId = event.source.userId;
      const userMessage = event.message.text;

      enqueueJob({ userId, userMessage });
    });

    // 先回 200 給 LINE，避免 499
    res.status(200).end();
  } catch (error) {
    console.error('Webhook Error:', error);
    res.status(200).end(); // 即使出錯也回 200，避免 LINE 重送太兇
  }
});

// 健康檢查路由
app.get('/', (req, res) => {
  if (useSiliconFlow && siliconClient) {
    res.send(`LINE AI Girlfriend Bot is running with SiliconFlow model: ${MODEL_NAME} 💕`);
  } else {
    res.send('LINE Girlfriend Bot is running (simple keyword mode, no SiliconFlow API key) 💕');
  }
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  if (useSiliconFlow && siliconClient) {
    console.log(`🌸 小櫻 AI 版 Bot 已啟動，使用 SiliconFlow 模型: ${MODEL_NAME}，監聽 port ${PORT}`);
  } else {
    console.log(`🌸 小櫻 簡單版 Bot 已啟動（未設定 SILICONFLOW_API_KEY），監聽 port ${PORT}`);
  }
});