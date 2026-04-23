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

// Generate post content via Claude
async function generatePostContent(imageBase64, userText) {
  const userMessage = userText
    ? `畑で撮った写真です。ユーザーからのメモ：「${userText}」`
    : "畑で撮った写真です。";

  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    system: `あなたは「まるはね農園」のSNS担当です。
自然栽培の野菜農家として、温かみのあるナチュラルな文体でInstagramやブログ向けの投稿文を作成します。

【文体ルール】
- ひらがな多め、やわらかい表現
- 農作業の喜びや自然の美しさを伝える
- 読者に畑の空気感が伝わるよう描写する
- 絵文字は最小限（🌱🥬🌿など野菜・自然系のみ）
- 改行を活用して読みやすく
- ハッシュタグは最後に5〜8個

【出力形式】
タイトル：（20字以内）
本文：（150〜250字）
ハッシュタグ：`,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: imageBase64,
            },
          },
          { type: "text", text: userMessage },
        ],
      },
    ],
  });

  const raw = response.content[0].text;

  // Parse title and body
  const titleMatch = raw.match(/タイトル[：:]\s*(.+)/);
  const bodyMatch = raw.match(/本文[：:]\s*([\s\S]+?)(?=ハッシュタグ[：:]|$)/);
  const tagsMatch = raw.match(/ハッシュタグ[：:]\s*([\s\S]+)$/);

  const title = titleMatch ? titleMatch[1].trim() : "まるはね農園より";
  const body = bodyMatch ? bodyMatch[1].trim() : raw;
  const tags = tagsMatch
    ? tagsMatch[1]
        .trim()
        .split(/[\s\n]+/)
        .filter((t) => t.startsWith("#"))
    : [];

  return { title, body, tags, raw };
}

// Upload image to WordPress Media Library
async function uploadWordPressMedia(imageBuffer, filename) {
  const wpUrl = process.env.WP_URL.replace(/\/$/, "");
  const credentials = Buffer.from(
    `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`
  ).toString("base64");

  return new Promise((resolve, reject) => {
    const parsed = new URL(`${wpUrl}/wp-json/wp/v2/media`);
    const lib = parsed.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname,
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "image/jpeg",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": imageBuffer.length,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`WP media upload failed: ${res.statusCode} ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(imageBuffer);
    req.end();
  });
}

// Create WordPress post
async function createWordPressPost(title, content, featuredMediaId, tags) {
  const wpUrl = process.env.WP_URL.replace(/\/$/, "");
  const credentials = Buffer.from(
    `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`
  ).toString("base64");

  const postData = JSON.stringify({
    title,
    content,
    status: "publish",
    featured_media: featuredMediaId,
    tags: [],
  });

  return new Promise((resolve, reject) => {
    const parsed = new URL(`${wpUrl}/wp-json/wp/v2/posts`);
    const lib = parsed.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname,
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`WP post failed: ${res.statusCode} ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// Main handler
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Verify LINE signature
  const signature = event.headers["x-line-signature"];
  if (!signature || !verifyLineSignature(event.body, signature)) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Bad Request" };
  }

  const lineEvents = parsed.events || [];

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

      // Collect image and text from this event
      let imageBuffer = null;
      let userText = "";

      for (const msg of messages) {
        if (msg.type === "image") {
          imageBuffer = await fetchLineContent(msg.id);
        } else if (msg.type === "text") {
          userText = msg.text;
        }
      }

      // Skip if no image
      if (!imageBuffer) continue;

      const imageBase64 = imageBuffer.toString("base64");

      // Generate post content
      const { title, body, tags } = await generatePostContent(imageBase64, userText);

      // Upload image to WordPress
      const filename = `farm-${Date.now()}.jpg`;
      const mediaData = await uploadWordPressMedia(imageBuffer, filename);

      // Build post content with hashtags
      const hashtags = tags.join(" ");
      const fullContent = `<p>${body.replace(/\n/g, "<br>")}</p>\n<p>${hashtags}</p>`;

      // Create WordPress post
      await createWordPressPost(title, fullContent, mediaData.id, tags);

      console.log(`Post created: ${title}`);
    } catch (err) {
      console.error("Error processing LINE event:", err);
    }
  }

  // LINE requires 200 OK
  return { statusCode: 200, body: JSON.stringify({ status: "ok" }) };
};
