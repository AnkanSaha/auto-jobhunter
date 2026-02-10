# Smart Job Auto-Applier 🚀

Automated job application system that uses Gemini AI to find relevant backend engineering positions and sends personalized cold emails highlighting your key achievements.

## Features

✅ **AI-Powered Job Search** - Uses Gemini 1.5 Pro with Google Search Grounding to find recent job postings  
✅ **Resume Parsing** - Extracts context from your PDF resume  
✅ **Personalized Emails** - Generates punchy, technical cold emails emphasizing cost savings and open-source work  
✅ **Job Queue System** - Reliable job processing with automatic retry on failure  
✅ **Custom SMTP** - Works with any email provider (custom domains supported)  
✅ **Rate Limiting** - 5-minute delay between emails (12 emails/hour max)  
✅ **Daily Scheduling** - Runs automatically at 11:00 AM IST  

## Installation

```bash
npm install
```

## Configuration

1. **Copy the example environment file:**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` with your credentials:**
   - Get Gemini API key from: https://aistudio.google.com/app/apikey
   - Add your custom domain SMTP settings (contact your email provider)

3. **Add your resume:**
   - Place your `resume.pdf` file in the project root directory

## Usage

### Run Initial Startup (Recommended)
```bash
npm start
```

This will:
1. ✅ Clear any existing queued jobs
2. ✅ Generate new jobs for today
3. ✅ Send ALL emails (no rate limit on startup)
4. ✅ Setup daily scheduler for 11:00 AM IST
5. ✅ Keep running in background

**Expected Output:**
```
🎬 INITIAL STARTUP RUN
==================================================
🧹 STEP 1: Clearing existing queue (5 jobs)...
✅ Queue completely cleared!

🔍 STEP 2: Generating new jobs for today...
📥 Added 15 jobs to queue

📨 STEP 3: Processing all newly added jobs...
[1/15] 🌍 🌐 Foreign | Score: 215 | Backend Engineer at Vercel
...
✅ All jobs processed successfully!

==================================================
📊 STARTUP RUN COMPLETE
==================================================

✅ Initial run completed!
⏰ Scheduler active: Job application will run daily at 11:00 AM IST
🔄 Service is running in the background...
```

### Run as Background Service
The script automatically stays running after initial startup and executes daily at 11:00 AM IST.

### Development Mode (Auto-reload)
```bash
npm run dev
```

## How It Works

### Initial Startup (`npm start`)
1. **Clear Existing Queue** - Process ALL jobs in queue (no rate limit)
2. **Parse Resume** - Extract complete text from `resume.pdf`
3. **Find Jobs** - Use Gemini AI with search grounding to find relevant positions
4. **Add to Queue** - Save all new jobs to `jobQueue.json`
5. **Process All** - Send ALL emails from queue (no rate limit on startup)
6. **Setup Scheduler** - Schedule daily runs at 11:00 AM IST
7. **Background Service** - Keep running and wait for scheduled time

### Daily Scheduled Runs (11 AM IST)
1. **Check Queue** - Process up to 12 jobs from queue (rate limited)
2. **Generate New** - If capacity available, find new jobs
3. **Add to Queue** - Save new jobs
4. **Process** - Send up to remaining capacity (max 12/hour)

### Email Generation
Personalized emails highlighting:
- "$3,000/month cost reduction using Cloudflare Workers"
- Open-source projects (NexoralDNS, xpack)
- Generic greetings (never personalized names)
- Relevant experience from full resume

### Error Handling
- **Success**: Remove from queue → Mark sent in jobs.json
- **Failure**: Keep in queue → Mark failed in jobs.json → Auto-retry next run

### Key Differences
| Startup Run | Scheduled Runs |
|-------------|----------------|
| Process ALL jobs | Max 12 jobs/hour |
| No rate limit | 5-min delays |
| Clear entire queue | Respect limits |
| One-time execution | Daily at 11 AM |

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `GEMINI_API_KEY` | Google Gemini API key | `AIza...` |
| `SMTP_HOST` | Mail server hostname | `mail.ankan.in` |
| `SMTP_PORT` | SMTP port (587/465) | `587` |
| `SMTP_SECURE` | Use SSL? (true for 465) | `false` |
| `SMTP_USER` | Full email address | `connect@ankan.in` |
| `SMTP_PASS` | Email password | `your_password` |

## SMTP Configuration Examples

See `.env.example` for detailed configurations for:
- Custom domain (cPanel/WHM)
- Zoho Mail
- Gmail (App Passwords)
- Office 365
- ProtonMail Bridge

## Project Structure

```
.
├── index.js           # Main application logic
├── package.json       # Dependencies
├── .env               # Environment variables (gitignored)
├── .env.example       # Example configuration
├── resume.pdf         # Your resume (gitignored)
├── jobs.json          # Sent/failed jobs history (auto-created)
├── jobQueue.json      # Pending jobs queue (auto-created)
└── README.md          # This file
```

## Key Achievements Highlighted in Emails

- ✅ Reduced infrastructure costs by $3,000/month using Cloudflare Workers
- ✅ Creator of open-source tools: NexoralDNS, xpack
- ✅ Backend Systems Engineer specializing in Node.js, Go, and cost optimization

## License

MIT © Ankan Saha
