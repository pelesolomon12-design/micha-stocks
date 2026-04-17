/**
 * עוזר למצוא את ה-Channel ID של מיקה סטוקס
 * הפעל: YOUTUBE_API_KEY=xxx npm run find-channel
 */
import { google } from "googleapis";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
if (!YOUTUBE_API_KEY) { console.error("❌ חסר YOUTUBE_API_KEY"); process.exit(1); }

const youtube = google.youtube({ version: "v3", auth: YOUTUBE_API_KEY });
const res = await youtube.search.list({
  q: "מיקה סטוקס",
  type: ["channel"],
  part: ["snippet"],
  maxResults: 5,
});

for (const item of res.data.items ?? []) {
  console.log(`Channel: ${item.snippet?.title}`);
  console.log(`  ID: ${item.id?.channelId}`);
  console.log(`  URL: https://youtube.com/channel/${item.id?.channelId}`);
  console.log();
}
