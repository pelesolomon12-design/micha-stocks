/**
 * Micha Stocks – דייג'סט אוטומטי
 * כל יומיים: מוריד סרטונים חדשים, מסכם לפי נושאים, ושולח במייל.
 *
 * משתני סביבה נדרשים:
 *   MICHA_STOCKS_CHANNEL_ID - מזהה ערוץ YouTube
 *   GEMINI_API_KEY          - מפתח Gemini API
 *   RESEND_API_KEY          - מפתח Resend API
 *   EMAIL_TO                - כתובת נמען (אפשר כמה, מופרדים בפסיק)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "..", "digest-state.json");

// ─── Config ──────────────────────────────────────────────────────────────────

const CHANNEL_ID = process.env.MICHA_STOCKS_CHANNEL_ID!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const EMAIL_TO = process.env.EMAIL_TO!;

// ─── State ────────────────────────────────────────────────────────────────────

interface DigestState {
  processedVideoIds: string[];
  lastRunAt: string | null;
}

function loadState(): DigestState {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  }
  return { processedVideoIds: [], lastRunAt: null };
}

function saveState(state: DigestState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ─── YouTube RSS – שליפת סרטונים ללא API key ─────────────────────────────────

interface VideoInfo {
  id: string;
  title: string;
  publishedAt: string;
  url: string;
  description: string;
}

async function getRecentVideos(sinceDate: Date): Promise<VideoInfo[]> {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
  const res = await fetch(rssUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
  });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);

  const xml = await res.text();

  // פרסור פשוט של XML
  const entries = xml.split("<entry>").slice(1);
  const videos: VideoInfo[] = [];

  for (const entry of entries) {
    const id = (entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) ?? [])[1];
    const title = (entry.match(/<title>([^<]+)<\/title>/) ?? [])[1];
    const published = (entry.match(/<published>([^<]+)<\/published>/) ?? [])[1];
    const description = (entry.match(/<media:description>([^<]*)<\/media:description>/) ?? [])[1] ?? "";

    if (!id || !title || !published) continue;

    const publishedDate = new Date(published);
    if (publishedDate <= sinceDate) continue;

    videos.push({
      id,
      title: title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'),
      publishedAt: published,
      url: `https://www.youtube.com/watch?v=${id}`,
      description: description.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
    });
  }

  return videos;
}

// ─── Gemini – סיכום לפי נושאים ──────────────────────────────────────────────

async function summarizeByTopics(videos: VideoInfo[]): Promise<string> {
  const videosText = videos
    .map(
      (v) =>
        `=== סרטון: "${v.title}" (${v.publishedAt.slice(0, 10)}) ===\n${v.description || "(אין תיאור)"}`
    )
    .join("\n\n");

  const prompt = `אתה מומחה לשוק ההון. להלן תיאורי ${videos.length} סרטונים של מיכה סטוקס מהימים האחרונים.

המשימה שלך: לכתוב סיכום מעמיק, מפורט ומובנה בעברית. **אל תקצר — הרחב על כל נושא ככל האפשר לפי המידע הקיים.**

---

## מבנה הסיכום:

### פסקת פתיחה
- פרט אילו נושאים יכוסו בסיכום זה.
- ציין מהו הנושא הקריטי/הדומיננטי ביותר של הימים האחרונים ולמה.

### נושאים מרכזיים
צור פסקה נפרדת לכל נושא (מניה / חברה / מדד / תחום / אסטרטגיה).

כללים לכל פסקת נושא:
- כותרת ברורה: "## שם הנושא"
- כתוב את המידע כעובדות וניתוח ישיר — **ללא** ביטויים כמו "בסרטון נאמר", "מיכה הסביר", "צוין כי". פשוט כתוב את המידע עצמו.
- **הדגש במודגש** משפטי מפתח, נתונים, ורמות מחיר חשובות.
- הרחב: פרט את הרקע, הנימוקים, הנתונים התומכים, והסיכונים אם יש.
- חלק לפסקאות משנה כשיש כמה היבטים לנושא.
- סיים כל נושא במשפט מודגש שמבטא את **עמדתו הסופית של מיכה** על הנושא.

### ניתוח טכני גרפי — סיכום מניות
אם בסרטונים בוצע ניתוח טכני/גרפי של מניות ספציפיות, צור פסקה נפרדת בסוף בשם "## ניתוח טכני גרפי".
לכל מניה שנותחה, כתוב שורה בפורמט הבא:
**שם המניה** — [כיוון צפוי: עלייה/ירידה/ניטרלי] | תבנית: [שם התבנית אם צוינה] | כניסה: [מחיר/רמה אם צוין] | יציאה/מטרה: [מחיר/רמה אם צוין] | סטופ: [אם צוין]
אם פרט מסוים לא צוין — השמט אותו.

### סרטונים שעובדו
רשימה עם כותרת ותאריך לכל סרטון.

---

**חשוב:** אל תמציא מידע. אם מידע לא נמצא בתיאורים — אל תכלול אותו. אל תחזור על אותו מידע פעמיים.

${videosText}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

// ─── Email ────────────────────────────────────────────────────────────────────

function markdownToHtml(md: string): string {
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br>")
    .replace(/^/, "<p>")
    .replace(/$/, "</p>");
}

async function sendEmail(subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Micha Stocks Digest <onboarding@resend.dev>",
      to: EMAIL_TO.split(",").map((e) => e.trim()),
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runDigest() {
  console.log("🚀 מתחיל digest של Micha Stocks...");

  const missing = [
    ["MICHA_STOCKS_CHANNEL_ID", CHANNEL_ID],
    ["GEMINI_API_KEY", GEMINI_API_KEY],
    ["RESEND_API_KEY", RESEND_API_KEY],
    ["EMAIL_TO", EMAIL_TO],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    console.error("❌ חסרים משתני סביבה:", missing.join(", "));
    process.exit(1);
  }

  const state = loadState();
  const sinceDate = state.lastRunAt
    ? new Date(state.lastRunAt)
    : new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  console.log(`📅 מחפש סרטונים מאז: ${sinceDate.toISOString()}`);

  const allVideos = await getRecentVideos(sinceDate);
  const newVideos = allVideos.filter(
    (v) => !state.processedVideoIds.includes(v.id)
  );

  if (newVideos.length === 0) {
    console.log("✅ אין סרטונים חדשים.");
    state.lastRunAt = new Date().toISOString();
    saveState(state);
    return;
  }

  console.log(`📹 נמצאו ${newVideos.length} סרטונים חדשים`);
  newVideos.forEach((v) => console.log(`  • "${v.title}" (${v.publishedAt.slice(0, 10)})`));

  console.log(`🤖 שולח ל-Gemini...`);
  const summary = await summarizeByTopics(newVideos);

  const dateStr = new Date().toLocaleDateString("he-IL");
  const subject = `📊 Micha Stocks Digest – ${dateStr}`;
  const html = `
    <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 800px; margin: auto;">
      <h1 style="color: #1a365d;">📊 Micha Stocks – סיכום נושאים</h1>
      <p style="color: #666;">עודכן: ${dateStr} | ${newVideos.length} סרטונים חדשים</p>
      <hr>
      ${markdownToHtml(summary)}
    </div>
  `;

  console.log("📧 שולח מייל...");
  await sendEmail(subject, html);
  console.log(`✅ מייל נשלח אל ${EMAIL_TO}`);

  state.processedVideoIds.push(...newVideos.map((v) => v.id));
  if (state.processedVideoIds.length > 500) {
    state.processedVideoIds = state.processedVideoIds.slice(-500);
  }
  state.lastRunAt = new Date().toISOString();
  saveState(state);
  console.log("💾 State נשמר.");
}

runDigest().catch((err) => {
  console.error("💥 שגיאה:", err);
  process.exit(1);
});
