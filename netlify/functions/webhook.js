const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// LINE signature verification
function verifyLineSignature(body, signature) {
  const hash = crypto
    .createHmac("sha256", process.env.LINE_CHANNEL_SECRET)
    .update(body)
    .digest("base64");
  return hash === signature;
}

// Download binary from URL
function downloadBinary(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    lib.get(url, { headers }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return downloadBinary(res.headers.location, headers)
          .then(resolve)
          .catch(reject);
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// Fetch LINE message content (image binary)
async function fetchLineContent(messageId) {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  return downloadBinary(url, {
    Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
  });
}

// Generate SNS post content via Claude
async function generatePostContent(imageBase64, userText) {
  const hasImage = !!imageBase64;
  const userMessage = hasImage
    ? (userText ? `畑で撮った写真です。ユーザーからのメモ：「${userText}」` : "畑で撮った写真です。")
    : (userText || "まるはね農園からのお知らせです。");

  const content = hasImage
    ? [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
        { type: "text", text: userMessage },
      ]
    : [{ type: "text", text: userMessage }];

  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    system: `あなたは「まるはね農園」のコーキさんです。
大分県で野菜を育てながら、日々の畑の様子をSNSに発信しています。
以下のコーキさんの文体でInstagramやブログの投稿文を書いてください。

【コーキさんの文体】
- 基本は標準語。ちょっと気が抜けるタイミングで大分弁がぽろっと出る程度
- 使っていい大分弁：〜やね、〜やろ、〜やけん、〜ちゃん（語尾）、まぁまぁ、なんか
- 関西弁・ほんまに・ほんま・〜やん は絶対使わない
- 絵文字は顔文字・感情表現のみ（😊😄😅😂🤔😌 など）。自然な流れで2〜3個程度使う。野菜・植物の絵文字は使わない
- 短い文をテンポよく重ねる。一文が長くなったら分ける
- 農作業中の独り言や現場の空気感を混ぜる（「あー疲れた笑」「どうしようかな〜」など）
- 読者に話しかけるように書く（「見てみて！」「わかる？」など）
- 丁寧すぎる表現・硬い言葉・です・ます調の連続は避ける

【ハッシュタグのルール】
- 自然栽培・有機栽培などの栽培方法に関するタグは使わない
- 農園名・野菜名・季節・大分など地域に関するタグを優先する

【出力形式】
タイトル：（20字以内）
本文：（150〜250字）
ハッシュタグ：（5〜8個）`,
    messages: [{ role: "user", content }],
  });

  const raw = response.content[0].text;

  const titleMatch = raw.match(/タイトル[：:]\s*(.+)/);
  const bodyMatch = raw.match(/本文[：:]\s*([\s\S]+?)(?=ハッシュタグ[：:]|$)/);
  const tagsMatch = raw.match(/ハッシュタグ[：:]\s*([\s\S]+)$/);

  const title = titleMatch ? titleMatch[1].trim() : "まるはね農園より";
  const body = bodyMatch ? bodyMatch[1].trim() : raw;
  const tags = tagsMatch
    ? tagsMatch[1].trim().split(/[\s\n]+/).filter((t) => t.startsWith("#"))
    : [];

  return { title, body, tags };
}

// Reply to LINE user
async function replyToLine(replyToken, text) {
  const body = JSON.stringify({
    replyToken,
    messages: [{ type: "text", text }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.line.me",
        path: "/v2/bot/message/reply",
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`LINE reply failed: ${res.statusCode} ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Main handler
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const signature = event.headers["x-line-signature"];
  if (!signature || !verifyLineSignature(event.body, signature)) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  // LINE webhook verification sends empty body or empty events
  if (!event.body || event.body.trim() === "") {
    return { statusCode: 200, body: JSON.stringify({ status: "ok" }) };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Bad Request" };
  }

  const lineEvents = parsed.events || [];

  if (lineEvents.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ status: "ok" }) };
  }

  const allowedUserIds = process.env.ALLOWED_USER_IDS
    ? process.env.ALLOWED_USER_IDS.split(",").map((id) => id.trim()).filter(Boolean)
    : [];

  for (const lineEvent of lineEvents) {
    if (lineEvent.type !== "message") continue;

    const userId = lineEvent.source?.userId;
    console.log(`Received message from userId: ${userId}`);

    if (allowedUserIds.length > 0 && !allowedUserIds.includes(userId)) {
      console.log(`userId ${userId} is not allowed. Skipping.`);
      continue;
    }

    try {
      const messages = Array.isArray(lineEvent.message)
        ? lineEvent.message
        : [lineEvent.message];

      let imageBuffer = null;
      let userText = "";

      for (const msg of messages) {
        if (msg.type === "image") {
          imageBuffer = await fetchLineContent(msg.id);
        } else if (msg.type === "text") {
          userText = msg.text;
        }
      }

      if (!imageBuffer && !userText) continue;

      const imageBase64 = imageBuffer ? imageBuffer.toString("base64") : null;
      const { title, body, tags } = await generatePostContent(imageBase64, userText);

      const replyText = `【${title}】\n\n${body}\n\n${tags.join(" ")}`;
      await replyToLine(lineEvent.replyToken, replyText);

      console.log(`Replied: ${title}`);
    } catch (err) {
      console.error("Error processing LINE event:", err);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ status: "ok" }) };
};
