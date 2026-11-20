# Kav AI Streaming

שרת WebSocket עצמאי לסטרימינג חי מול **טכנוליין / TLIVR** ו־**Gemini Live**.
הפרויקט אינו משנה את הפרויקט הקיים בתיקיית השורש.

## נקודת חיבור

- WebSocket: `wss://<הדומיין-שלך>/voice`
- בדיקה HTTP: `/`
- בדיקת בריאות: `/health`

בממשק הטכנוליין יש ליצור ערוץ סטרימינג ולהגדיר את נקודת הקצה ל־`wss://<הדומיין-שלך>/voice`.
אם הוגדר סוד בערוץ, הגדר אותו גם כ־`STREAM_SECRET` בשרת. החיבור חייב לשלוח:

```text
Authorization: Bearer <STREAM_SECRET>
```

## פורמט אודיו

- טכנוליין אל השרת: PCM16 little-endian, mono, 8000 Hz.
- השרת שולח ל־Gemini: PCM16, mono, 16000 Hz.
- Gemini אל השרת: אודיו 24000 Hz בדרך כלל.
- השרת משדר לטכנוליין: PCM16, mono, 8000 Hz.

## הפעלה מקומית

```powershell
cd streaming
npm install
Copy-Item .env.example .env
# מלאו GEMINI_API_KEY ו-STREAM_SECRET
node server.js
```

להפעלת wss מקומי צריך reverse proxy ו־TLS.

## משתני סביבה

| משתנה | חובה | תיאור |
|---|---|---|
| `GEMINI_API_KEY` | כן | מפתח Google Gemini |
| `STREAM_SECRET` | מומלץ | סוד Bearer של ערוץ הטכנוליין |
| `GEMINI_LIVE_MODEL` | לא | מודל Gemini Live Audio |
| `GEMINI_VOICE` | לא | קול Gemini, למשל Kore או Charon |
| `SYSTEM_INSTRUCTION` | לא | הנחיית המערכת למודל |

## אירועים

השרת מקבל:

- `start` — מאתחל סשן Gemini Live ומגדיר את פרטי השיחה.
- פריימים בינאריים — אודיו המתקשר.
- `dtmf` — שולח בקשה טקסטואלית למודל (DTMF אינו נתמך כרגע במרכזייה המצויה לפי המדריך).
- `hangup` — סוגר את סשן Gemini וסוגר את הסוקט.

השרת יכול לשלוח לטכנוליין:

- פריימים בינאריים — אודיו Gemini.
- `clear` — barge-in.

ניתוב סופי יכול להתבצע על ידי שליחה ידנית מהקוד:

```json
{"type":"transfer_extension","target":"/2"}
```

```json
{"type":"transfer_phone","target":"03XXXXXXX"}
```

```json
{"type":"transfer_queue","target":"<queue-id>"}
```

```json
{"type":"hangup"}
```

לפני פקודה סופית יש לסיים קודם משפט סיום ולהמשיך לשלוח את האודיו שלו, ואז לשלוח את הפקודה תוך עד 6 שניות ניקוז.
