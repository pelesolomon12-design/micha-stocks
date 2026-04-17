/**
 * Micha Stocks – דייג'סט אוטומטי
 * כל יומיים: מוריד סרטונים חדשים, מסכם לפי נושאים, ושולח במייל.
 *
 * משתני סביבה נדרשים:
 *   YOUTUBE_API_KEY         - מפתח YouTube Data API v3
 *   MICHA_STOCKS_CHANNEL_ID - מזהה ערוץ YouTube
 *   GEMINI_API_KEY          - מפתח Gemini API
 *   EMAIL_USER              - כתובת שולח (Gmail)
 *   EMAIL_PASS              - סיסמת אפליקציה של Gmail
 *   EMAIL_TO                - כתובת נמען (אפשר כמה, מופרדים בפסיק)
 */

import nodemailer from "nodemailer";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
// @ts-ignore
import ytDlp from "yt-dlp-exec";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "..", "digest-state.json");

// ─── Config ──────────────────────────────────────────────────────────────────

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY!;
const CHANNEL_ID = process.env.MICHA_STOCKS_CHANNEL_ID!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const EMAIL_USER = process.env.EMAIL_USER!;
const EMAIL_PASS = process.env.EMAIL_PASS!;
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

// ─── YouTube – שליפת סרטונים ─────────────────────────────────────────────────

interface VideoInfo {
  id: string;
  title: string;
  publishedAt: string;
  url: string;
}

async function getRecentVideos(sinceDate: Date): Promise<VideoInfo[]> {
  const youtube = google.youtube({ version: "v3", auth: YOUTUBE_API_KEY });
  const res = await youtube.search.list({
    channelId: CHANNEL_ID,
    part: ["snippet"],
    order: "date",
    type: ["video"],
    maxResults: 20,
    publishedAfter: sinceDate.toISOString(),
  });
  return (res.data.items ?? []).map((item) => ({
    id: item.id!.videoId!,
    title: item.snippet!.title!,
    publishedAt: item.snippet!.publishedAt!,
    url: `https://www.youtube.com/watch?v=${item.id!.videoId}`,
  }));
}

// ─── Transcript – שליפת כתוביות עם yt-dlp ───────────────────────────────────

async function getTranscript(videoId: string): Promise<string | null> {
  const tmpDir = path.join(__dirname, "..", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpBase = path.join(tmpDir, videoId);

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    await ytDlp(url, {
      skipDownload: true,
      writeAutoSub: true,
      writeSub: true,
      subLangs: "he,iw,en",
      subFormat: "vtt",
      output: tmpBase,
      noWarnings: true,
      quiet: true,
    });

    // מחפש קובץ כתוביות שנוצר
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(videoId) && f.endsWith(".vtt"));
    if (files.length === 0) return null;

    const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf-8");
    // מנקה את פורמט VTT
    const text = content
      .replace(/WEBVTT[\s\S]*?\n\n/, "")
      .replace(/\d{2}:\d{2}:\d{2}\.\d+ --> [\s\S]+?\n/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{2,}/g, " ")
      .trim();

    // מוחק קבצים זמניים
    files.forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
    return text || null;
  } catch {
    // מנקה קבצים זמניים במקרה של שגיאה
    try {
      fs.readdirSync(tmpDir).filter(f => f.startsWith(videoId)).forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
    } catch {}
    return null;
  }
}

// ─── Gemini – סיכום לפי נושאים ───────────────────────────────────────────────

async function summarizeByTopics(
  videos: Array<{ info: VideoInfo; transcript: string }>
): Promise<string> {
  const videosText = videos
    .map(
      ({ info, transcript }) =>
        `=== סרטון: "${info.title}" (${info.publishedAt.slice(0, 10)}) ===\n${transcript}`
    )
    .join("\n\n");

  const prompt = `אתה מומחה לשוק ההון ולסיכום תוכן.
להלן תמלולי ${videos.length} סרטונים חדשים של Micha Stocks. אנא סכם לפי נושאים.

כללים:
- קבץ תכנים לפי נושא (מניה / חברה / תחום), גם אם הוזכרו בסרטונים שונים.
- כל נושא מקבל כותרת ברורה.
- פרט מה נאמר, מה הדעה/המלצה, ומה הנימוק.
- כתוב בעברית, בצורה קריאה ומובנת.
- אל תחזור על אותו מידע פעמיים.
- בסוף: "סרטונים שעובדו" עם הכותרות והתאריכים.

${videosText}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
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
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });
  await transporter.sendMail({
    from: `"Micha Stocks Digest" <${EMAIL_USER}>`,
    to: EMAIL_TO.split(",")
      .map((e) => e.trim())
      .join(", "),
    subject,
    html,
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runDigest() {
  console.log("🚀 מתחיל digest של Micha Stocks...");

  const missing = [
    ["YOUTUBE_API_KEY", YOUTUBE_API_KEY],
    ["MICHA_STOCKS_CHANNEL_ID", CHANNEL_ID],
    ["GEMINI_API_KEY", GEMINI_API_KEY],
    ["EMAIL_USER", EMAIL_USER],
    ["EMAIL_PASS", EMAIL_PASS],
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

  const videosWithTranscripts: Array<{ info: VideoInfo; transcript: string }> =
    [];
  for (const video of newVideos) {
    console.log(`  📝 מוריד טרנסקריפט: "${video.title}"`);
    const transcript = await getTranscript(video.id);
    if (transcript) {
      videosWithTranscripts.push({ info: video, transcript });
    } else {
      console.warn(`  ⚠️  אין כתוביות ל-"${video.title}"`);
    }
  }

  if (videosWithTranscripts.length === 0) {
    console.warn("⚠️  לאף סרטון אין טרנסקריפט זמין.");
    return;
  }

  console.log(`🤖 שולח ל-Gemini...`);
  const summary = await summarizeByTopics(videosWithTranscripts);

  const dateStr = new Date().toLocaleDateString("he-IL");
  const subject = `📊 Micha Stocks Digest – ${dateStr}`;
  const html = `
    <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 800px; margin: auto;">
      <h1 style="color: #1a365d;">📊 Micha Stocks – סיכום נושאים</h1>
      <p style="color: #666;">עודכן: ${dateStr} | ${videosWithTranscripts.length} סרטונים חדשים</p>
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
