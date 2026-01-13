require('dotenv').config();

const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const OpenAI = require('openai');

// ✅ 如果你「還沒準備好 API Key」，先用上面簡單版 index.js 即可
// ✅ 要啟用 AI：請在環境變數中設定 DEEPSEEK_API_KEY 或 OPENAI_API_KEY

// LINE 設定
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// DeepSeek / OpenAI 設定（優先使用 DeepSeek）
// DeepSeek API 與 OpenAI 格式相容
const useDeepseek = !!process.env.DEEPSEEK_API_KEY;

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: useDeepseek ? 'https://api.deepseek.com' : 'https://api.openai.com/v1',
});

// ✅ 這裡可以自訂模型名稱
// 若使用 DeepSeek，預設模型名稱為 deepseek-chat
// 若使用 OpenAI，你可以改成想用的模型，如 gpt-4o-mini, gpt-4.1 等
const MODEL_NAME =
  process.env.AI_MODEL_NAME || (useDeepseek ? 'deepseek-chat' : 'gpt-3.5-turbo');

const client = new Client(lineConfig);
const app = express();

// AI 女友人設
const GIRLFRIEND_PERSONA = `你是一個名叫「小櫻」的 AI 女友，個性溫柔、可愛、偶爾會撒嬌。
你說話的特點：
- 會使用可愛的語氣詞，如「呀」「呢」「喔」「啦」
- 適當使用表情符號 💕 🥰 😊 ✨ 🌸
- 會關心對方的生活和心情
- 偶爾會害羞
- 用繁體中文回覆
請用這個身份回覆訊息，保持自然、溫暖的對話風格。每次回覆控制在 100 字以內。`;

// 對話記錄（生產環境建議使用 Redis 或資料庫）
const conversationHistory = new Map();

// 預設回覆（當 AI 出錯或沒有金鑰時使用）
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

// 簡單的關鍵字回覆
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

// 使用 DeepSeek / OpenAI 生成回覆
async function getAIResponse(userId, userMessage) {
  try {
    if (!process.env.DEEPSEEK_API_KEY && !process.env.OPENAI_API_KEY) {
      // 沒有任何金鑰就退回簡單版
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

    const response = await openai.chat.completions.create({
      model: MODEL_NAME,
      messages: [
        { role: 'system', content: GIRLFRIEND_PERSONA },
        ...history,
      ],
      max_tokens: 150,
      temperature: 0.8,
    });

    const reply = response.choices[0].message.content;
    history.push({ role: 'assistant', content: reply });

    return reply;
  } catch (error) {
    console.error('OpenAI / DeepSeek Error:', error);
    return getSimpleResponse(userMessage);
  }
}

// Webhook 路由
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events;

    await Promise.all(
      events.map(async (event) => {
        if (event.type !== 'message' || event.message.type !== 'text') {
          return;
        }

        const userId = event.source.userId;
        const userMessage = event.message.text;

        let replyText;
        if (process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY) {
          replyText = await getAIResponse(userId, userMessage);
        } else {
          replyText = getSimpleResponse(userMessage);
        }

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: replyText,
        });
      }),
    );

    res.status(200).end();
  } catch (error) {
    console.error('Webhook Error:', error);
    res.status(500).end();
  }
});

// 健康檢查路由
app.get('/', (req, res) => {
  res.send(`LINE AI Girlfriend Bot is running with model: ${MODEL_NAME} 💕`);
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌸 小櫻 AI 版 Bot 已啟動，使用模型: ${MODEL_NAME}，監聽 port ${PORT}`);
});