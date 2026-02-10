import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import nodemailer from 'nodemailer';
import pdf from 'pdf-parse';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RESUME_PATH = path.join(__dirname, 'resume.pdf');
const JOBS_DB_PATH = path.join(__dirname, 'jobs.json');
const QUEUE_PATH = path.join(__dirname, 'jobQueue.json');
const SENDER_EMAIL = 'connect@ankan.in';
const SENDER_NAME = 'Ankan Saha';

// Rate limit: 12 emails per hour
const MAX_EMAILS_PER_RUN = 12;
const EMAIL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between emails (12 per hour)

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// JSON file database functions
async function loadJobsDb() {
  try {
    const data = await fs.readFile(JOBS_DB_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    // File doesn't exist, return empty structure
    return { jobs: [], sentEmails: [], sentCompanies: [] };
  }
}

async function saveJobsDb(db) {
  await fs.writeFile(JOBS_DB_PATH, JSON.stringify(db, null, 2));
}

// Job Queue functions
async function loadQueue() {
  try {
    const data = await fs.readFile(QUEUE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    // File doesn't exist, return empty array
    return [];
  }
}

async function saveQueue(queue) {
  await fs.writeFile(QUEUE_PATH, JSON.stringify(queue, null, 2));
}

async function addJobsToQueue(jobs) {
  const queue = await loadQueue();
  queue.push(...jobs);
  await saveQueue(queue);
  console.log(`📥 Added ${jobs.length} jobs to queue (Total in queue: ${queue.length})`);
}

async function removeJobFromQueue(jobIndex) {
  const queue = await loadQueue();
  if (jobIndex >= 0 && jobIndex < queue.length) {
    const removed = queue.splice(jobIndex, 1);
    await saveQueue(queue);
    return removed[0];
  }
  return null;
}

async function getQueueSize() {
  const queue = await loadQueue();
  return queue.length;
}

async function isEmailSent(email) {
  const db = await loadJobsDb();
  return db.sentEmails.includes(email.toLowerCase());
}

async function isCompanySent(company) {
  const db = await loadJobsDb();
  return db.sentCompanies.includes(company.toLowerCase());
}

async function markJobSent(job) {
  const db = await loadJobsDb();

  db.jobs.push({
    ...job,
    status: 'sent',
    sentAt: new Date().toISOString()
  });

  // Track all emails sent
  if (job.hrEmail) {
    db.sentEmails.push(job.hrEmail.toLowerCase());
  }
  if (job.decisionMakerEmail) {
    db.sentEmails.push(job.decisionMakerEmail.toLowerCase());
  }
  db.sentCompanies.push(job.company.toLowerCase());

  await saveJobsDb(db);
  const emailList = [job.hrEmail, job.decisionMakerEmail].filter(Boolean).join(', ');
  console.log(`💾 Saved to DB: ${job.company} (${emailList})`);
}

async function markJobFailed(job, errorMessage) {
  const db = await loadJobsDb();

  db.jobs.push({
    ...job,
    status: 'failed',
    errorMessage,
    failedAt: new Date().toISOString()
  });
  // Don't add to sentEmails so we can retry later
  // But add to sentCompanies to avoid duplicate company contacts
  db.sentCompanies.push(job.company.toLowerCase());

  await saveJobsDb(db);
  console.log(`💾 Saved failed job: ${job.company}`);
}

async function getSentCompanies() {
  const db = await loadJobsDb();
  return db.sentCompanies;
}

async function getJobStats() {
  const db = await loadJobsDb();
  const sent = db.jobs.filter(j => j.status === 'sent').length;
  const failed = db.jobs.filter(j => j.status === 'failed').length;
  return { total: db.jobs.length, sent, failed };
}

async function parseResume() {
  try {
    console.log('📄 Parsing resume...');
    const dataBuffer = await fs.readFile(RESUME_PATH);
    const data = await pdf(dataBuffer);
    console.log(`✅ Resume parsed: ${data.text.length} characters extracted`);
    return data.text;
  } catch (error) {
    console.error('❌ Failed to parse resume:', error.message);
    throw error;
  }
}

function extractSkills(resumeText) {
  const skillPatterns = [
    /Node\.?js/gi, /TypeScript/gi, /JavaScript/gi, /Python/gi, /Go(lang)?/gi,
    /Docker/gi, /Kubernetes/gi, /AWS/gi, /GCP/gi, /Azure/gi, /Cloudflare/gi,
    /PostgreSQL/gi, /MongoDB/gi, /Redis/gi, /MySQL/gi, /Kafka/gi, /RabbitMQ/gi,
    /GraphQL/gi, /REST/gi, /gRPC/gi, /WebSocket/gi,
    /React/gi, /Next\.?js/gi, /Vue/gi, /Svelte/gi,
    /CI\/CD/gi, /Terraform/gi, /Linux/gi, /Nginx/gi,
    /Microservices/gi, /Distributed Systems/gi, /System Design/gi
  ];

  const skills = new Set();
  for (const pattern of skillPatterns) {
    const matches = resumeText.match(pattern);
    if (matches) {
      matches.forEach(m => skills.add(m.toLowerCase()));
    }
  }
  return Array.from(skills);
}

function scoreJob(job, resumeSkills) {
  let score = 0;

  // Work type priority: remote > hybrid > onsite
  const workType = (job.workType || '').toLowerCase();
  if (workType === 'remote') score += 100;
  else if (workType === 'hybrid') score += 50;
  else if (workType === 'onsite') score += 10;

  // Company type bonus
  const companyType = (job.companyType || '').toLowerCase();
  if (companyType.includes('foreign') || companyType.includes('international')) score += 40;
  if (companyType.includes('startup')) score += 30;
  if (job.isFamous) score += 25;

  // Skill match score
  const jobDescription = `${job.role} ${job.snippet} ${job.requirements || ''}`.toLowerCase();
  let matchedSkills = 0;
  for (const skill of resumeSkills) {
    if (jobDescription.includes(skill)) matchedSkills++;
  }
  score += matchedSkills * 15;

  // Funding stage bonus
  const funding = (job.fundingStage || '').toLowerCase();
  if (funding.includes('series b') || funding.includes('series c')) score += 20;
  else if (funding.includes('series a')) score += 15;

  return score;
}

async function findJobs(resumeText) {
  try {
    console.log('🔍 Searching for jobs using Gemini with Search Grounding...');

    const resumeSkills = extractSkills(resumeText);
    console.log(`📋 Extracted skills: ${resumeSkills.join(', ')}`);

    // Get already contacted companies to exclude
    const sentCompanies = await getSentCompanies();
    const excludeSection = sentCompanies.length > 0
      ? `

STRICT EXCLUSION - DO NOT INCLUDE THESE COMPANIES (already contacted, skip them completely):
${sentCompanies.join(', ')}

DO NOT return any job from the above companies. Find NEW companies only.`
      : '';

    const prompt = `Search for Backend Engineer, Systems Engineer, Platform Engineer, or Infrastructure Engineer job openings posted in the last 24-48 hours.

CRITICAL: ONLY find jobs matching the ACTUAL tech stack below. DO NOT return jobs for Java, C#, .NET, Ruby, PHP, or any language NOT listed.

REQUIRED TECH STACK (job MUST match at least 2 of these):
✅ Node.js, TypeScript, JavaScript, Golang
✅ React.js, Next.js (for Full Stack roles)
✅ Docker, Kubernetes, Cloudflare Workers
✅ MongoDB, Redis, PostgreSQL
✅ Microservices, System Design, CI/CD

❌ EXCLUDE these (DO NOT return):
- Java / Spring Boot jobs
- C# / .NET jobs
- Ruby / Rails jobs
- PHP / Laravel jobs
- Python-only jobs (unless also mentions Node.js/TypeScript)

${excludeSection}

PRIORITY ORDER for search:
1. REMOTE positions (fully remote, work from anywhere)
2. HYBRID positions (partial remote)
3. ON-SITE positions (only if no remote/hybrid found)

TARGET COMPANIES (search for jobs at these types of companies):
- Famous International/Foreign startups hiring in India: Vercel, Supabase, Cloudflare, Stripe, Figma, Notion, Linear, Railway, Fly.io, PlanetScale, Turso, Neon, Deno, Bun
- Famous Indian startups: Razorpay, Cred, Zerodha, Postman, Hasura, Groww, Meesho, CRED, PhonePe, Swiggy, Zomato, Flipkart, Atlassian India
- Well-funded startups (Series A/B/C) with strong engineering culture
- Companies known for open-source contributions

APPLICANT INFO (use this to write personalized emails):
- Name: Ankan Saha
- Role: Backend Systems Engineer (Node.js/TypeScript/Golang)
- Key Achievement: Reduced infrastructure costs by $3,000/month using Cloudflare Workers
- Open Source: Creator of NexoralDNS (self-hosted DNS server) and xpack (universal Linux package builder)
- Tech Stack: Node.js, TypeScript, JavaScript, Golang, React, Docker, Kubernetes, MongoDB, Redis
- Skills: ${resumeSkills.join(', ')}

COMPLETE RESUME (use this detailed information to craft accurate, relevant emails):
${resumeText}

For each job found, extract ALL of these fields AND generate a personalized cold email:

JOB FIELDS:
1. company - Company name
2. role - Exact job title
3. snippet - Brief description (1-2 lines)
4. requirements - Key technical requirements mentioned
5. workType - Must be one of: "remote", "hybrid", "onsite"
6. companyType - One of: "foreign_startup", "indian_startup", "enterprise"
7. isFamous - true if it's a well-known company, false otherwise
8. fundingStage - If known (e.g., "Series A", "Series B", "Public")
9. location - Office location or "Remote"
10. hrEmail - HR/Careers email (use patterns: jobs@, hiring@, careers@, talent@, hr@, or team@company.com)
11. decisionMakerEmail - Try to find CTO, VP Engineering, Engineering Manager, or Tech Lead email. If not found, set to null.
12. decisionMakerName - Name and title of the decision maker if found. If not found, set to null.

EMAIL FIELDS (generate personalized for each job):
13. emailSubject - Bold, direct subject line (e.g., "Backend Engineer Who Cut Infra Costs by $3K/mo")
14. emailBody - Punchy cold email (max 150 words) that:
    - CRITICAL: DO NOT use personalized greetings with names (e.g., "Hi John", "Hello Sarah")
    - START with generic greeting: "Hi," or "Hello," (no names)
    - MUST mention: "Reduced infrastructure costs by $3,000/month using Cloudflare Workers"
    - MUST mention: "Creator of open-source tools like NexoralDNS and xpack"
    - When mentioning projects, be ACCURATE:
      * NexoralDNS = self-hosted DNS server (NOT database)
      * xpack = universal Linux package builder (NOT database)
      * AxioDB = embedded NoSQL database engine (if mentioning database work)
    - Connects skills to the specific role/company using COMPLETE RESUME details
    - Ends with strong call-to-action
    - Tone: "I solve expensive backend problems"
    - Sign off as: Ankan Saha

Return ONLY a valid JSON array with this structure:
[
  {
    "company": "Company Name",
    "role": "Job Title",
    "snippet": "Brief description",
    "requirements": "Node.js, Kubernetes, AWS",
    "workType": "remote",
    "companyType": "foreign_startup",
    "isFamous": true,
    "fundingStage": "Series B",
    "location": "Remote",
    "hrEmail": "hiring@company.com",
    "decisionMakerEmail": "cto@company.com",
    "decisionMakerName": "John Doe, CTO",
    "emailSubject": "Backend Engineer Who Cut Infra Costs by $3K/mo - Interested in Role",
    "emailBody": "Hi,\\n\\nI noticed Company is hiring for Role...\\n\\nBest,\\nAnkan Saha"
  }
]

IMPORTANT:
- ONLY return jobs that match the Node.js/TypeScript/Golang tech stack
- Prioritize jobs that match the resume skills
- Return at least 10-15 NEW jobs (not from excluded list)
- Try hard to find decision maker emails - this significantly increases response rates
- Each emailBody must be UNIQUE and tailored to that specific company/role
- Use proper newlines (\\n) in emailBody for formatting
- NEVER use personalized names in greetings - always use generic "Hi," or "Hello,"
- Be ACCURATE about project descriptions using the complete resume data provided above
- Focus on relevant experience from the full resume based on job requirements
- DO NOT include Java, C#, .NET, Ruby, PHP, or Python-only jobs`;

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const text = response.text;

    console.log('Raw Gemini Response:', text);

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log('⚠️ No jobs found in valid JSON format');
      return [];
    }

    let jobs = JSON.parse(jsonMatch[0]);

    // Score and sort jobs
    jobs = jobs.map(job => ({
      ...job,
      score: scoreJob(job, resumeSkills)
    }));

    jobs.sort((a, b) => b.score - a.score);

    console.log(`\n📊 Job Rankings:`);
    jobs.forEach((job, i) => {
      const workIcon = job.workType === 'remote' ? '🌍' : job.workType === 'hybrid' ? '🏠' : '🏢';
      const dmIcon = job.decisionMakerEmail ? '👔' : '  ';
      console.log(`  ${i + 1}. [Score: ${job.score}] ${workIcon} ${dmIcon} ${job.role} at ${job.company} (${job.workType})`);
    });
    console.log(`  Legend: 👔 = Decision maker email found`);

    console.log(`\n✅ Found ${jobs.length} jobs, sorted by match score`);
    return jobs;

  } catch (error) {
    console.error('❌ Failed to find jobs:', error.message);
    return [];
  }
}

async function sendEmail(recipients, subject, body) {
  // recipients can be a string or array of emails
  const toList = Array.isArray(recipients) ? recipients.filter(Boolean) : [recipients];

  if (toList.length === 0) {
    throw new Error('No valid recipients');
  }

  try {
    const mailOptions = {
      from: `"${SENDER_NAME}" <${SENDER_EMAIL}>`,
      to: toList.join(', '),
      subject,
      text: body,
      html: `<pre style="font-family: Arial, sans-serif; white-space: pre-wrap;">${body}</pre>`,
      attachments: [
        {
          filename: 'resume.pdf',
          path: RESUME_PATH,
        },
      ],
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to: ${toList.join(', ')} (with resume attached)`);

  } catch (error) {
    console.error(`❌ Failed to send email to ${toList.join(', ')}:`, error.message);
    throw error;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processJobQueue(clearAll = false) {
  const queueSize = await getQueueSize();
  
  if (queueSize === 0) {
    console.log('📭 Queue is empty. No pending jobs to process.');
    return 0;
  }

  console.log(`\n📬 Found ${queueSize} jobs in queue. Processing...`);
  
  const queue = await loadQueue();
  const jobsToProcess = clearAll ? queue : queue.slice(0, MAX_EMAILS_PER_RUN);
  
  // Calculate estimated completion time
  const totalDelayMs = (jobsToProcess.length - 1) * EMAIL_INTERVAL_MS;
  const estimatedEndTime = new Date(Date.now() + totalDelayMs);
  const estimatedMinutes = Math.round(totalDelayMs / 60000);

  if (clearAll) {
    console.log(`🔥 CLEARING ENTIRE QUEUE: Processing all ${jobsToProcess.length} jobs...`);
  } else {
    console.log(`📧 Processing ${jobsToProcess.length} jobs from queue (max ${MAX_EMAILS_PER_RUN}/hour)...`);
  }
  console.log(`⏱️ Estimated time: ~${estimatedMinutes} minutes`);
  console.log(`🏁 Expected completion: ${estimatedEndTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n`);

  let sentCount = 0;
  let failedCount = 0;

  for (let i = 0; i < jobsToProcess.length; i++) {
    const job = jobsToProcess[i];
    const workIcon = job.workType === 'remote' ? '🌍' : job.workType === 'hybrid' ? '🏠' : '🏢';
    const typeLabel = job.companyType === 'foreign_startup' ? '🌐 Foreign' : job.companyType === 'indian_startup' ? '🇮🇳 Indian' : '🏛️ Enterprise';

    // Build recipient list
    const recipients = [job.hrEmail];
    if (job.decisionMakerEmail) {
      recipients.push(job.decisionMakerEmail);
    }

    console.log(`[${i + 1}/${jobsToProcess.length}] ${workIcon} ${typeLabel} | Score: ${job.score} | ${job.role} at ${job.company}`);
    console.log(`  📧 HR: ${job.hrEmail}`);
    if (job.decisionMakerEmail) {
      console.log(`  👔 Decision Maker: ${job.decisionMakerName || 'Unknown'} <${job.decisionMakerEmail}>`);
    }

    try {
      // Use pre-generated email content from Gemini
      const subject = job.emailSubject || `Application for ${job.role} at ${job.company}`;
      const body = (job.emailBody || '').replace(/\\n/g, '\n');

      if (!body) {
        throw new Error('No email body generated');
      }

      await sendEmail(recipients, subject, body);

      // Mark as sent in jobs.json
      await markJobSent(job);
      
      // Remove from queue (success)
      await removeJobFromQueue(0); // Always remove first item as we process in order
      console.log(`✅ Removed from queue`);
      
      sentCount++;
    } catch (error) {
      console.error(`⚠️ Failed ${job.company}:`, error.message);
      
      // Mark as failed in jobs.json but KEEP in queue
      await markJobFailed(job, error.message);
      console.log(`⚠️ Kept in queue for retry`);
      
      failedCount++;
    }

    // Wait 5 minutes between emails regardless of success/failure (12 per hour)
    if (i < jobsToProcess.length - 1) {
      console.log(`⏳ Waiting 5 minutes before next email...`);
      await delay(EMAIL_INTERVAL_MS);
    }
  }

  console.log(`\n📊 Queue Processing Stats: Sent ${sentCount} | Failed ${failedCount}`);
  
  return sentCount;
}

async function runJobApplicationCycle(isScheduled = false) {
  console.log('\n🚀 Starting job application cycle...');
  console.log(`⏰ Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
  console.log(`📧 Rate limit: ${MAX_EMAILS_PER_RUN} emails/hour\n`);

  try {
    // STEP 1: Check and process existing queue first
    const queueSize = await getQueueSize();
    
    if (queueSize > 0) {
      console.log(`\n🔄 Processing existing queue (${queueSize} jobs pending)...`);
      const processedCount = await processJobQueue(false); // Regular processing (max 12)
      
      // If we processed the max limit, don't generate new jobs this cycle
      if (processedCount >= MAX_EMAILS_PER_RUN) {
        console.log(`\n✅ Processed ${processedCount} jobs from queue. Max limit reached.`);
        console.log(`📝 Will generate new jobs in next cycle (if queue is empty).\n`);
        return;
      }
    }

    // STEP 2: Generate new jobs only if queue is empty or we have capacity
    console.log(`\n🔍 Generating new job listings...`);
    const resumeText = await parseResume();
    const jobs = await findJobs(resumeText);

    if (jobs.length === 0) {
      console.log('⚠️ No new jobs found. Skipping this cycle.');
      return;
    }

    // Filter out already contacted emails and companies
    console.log(`\n🔍 Filtering already contacted...`);
    const newJobs = [];
    for (const job of jobs) {
      const hrEmailSent = job.hrEmail ? await isEmailSent(job.hrEmail) : false;
      const companySent = await isCompanySent(job.company);

      if (hrEmailSent) {
        console.log(`  ⏭️ Email already sent: ${job.hrEmail}`);
        continue;
      }
      if (companySent) {
        console.log(`  ⏭️ Company already contacted: ${job.company}`);
        continue;
      }
      newJobs.push(job);
    }

    if (newJobs.length === 0) {
      console.log('⚠️ All jobs already contacted. Skipping this cycle.');
      return;
    }

    // Add all new jobs to queue
    await addJobsToQueue(newJobs);
    
    // Process jobs from queue (up to max limit)
    console.log(`\n📨 Starting to process newly added jobs...`);
    await processJobQueue(false); // Regular processing (max 12)

    // Show final stats
    const stats = await getJobStats();
    const remainingInQueue = await getQueueSize();
    
    console.log('\n📊 Final Stats:');
    console.log(`  All time: Total ${stats.total} | Sent ${stats.sent} | Failed ${stats.failed}`);
    console.log(`  Queue: ${remainingInQueue} jobs pending`);

    console.log('\n✨ Job application cycle completed!\n');

  } catch (error) {
    console.error('❌ Fatal error in job application cycle:', error.message);
  }
}

async function initialStartupRun() {
  console.log('\n🎬 INITIAL STARTUP RUN');
  console.log('=' .repeat(60));
  
  try {
    // STEP 1: Clear existing queue completely
    const initialQueueSize = await getQueueSize();
    if (initialQueueSize > 0) {
      console.log(`\n🧹 STEP 1: Clearing existing queue (${initialQueueSize} jobs)...`);
      await processJobQueue(true); // Clear all jobs in queue
      
      const remainingAfterClear = await getQueueSize();
      if (remainingAfterClear > 0) {
        console.log(`⚠️ Warning: ${remainingAfterClear} jobs failed to send (will retry later)`);
      } else {
        console.log(`✅ Queue completely cleared!`);
      }
    } else {
      console.log(`\n✅ STEP 1: Queue is already empty.`);
    }

    // STEP 2: Generate and process new jobs
    console.log(`\n🔍 STEP 2: Generating new jobs for today...`);
    const resumeText = await parseResume();
    const jobs = await findJobs(resumeText);

    if (jobs.length === 0) {
      console.log('⚠️ No new jobs found.');
    } else {
      // Filter out already contacted
      console.log(`\n🔍 Filtering already contacted...`);
      const newJobs = [];
      for (const job of jobs) {
        const hrEmailSent = job.hrEmail ? await isEmailSent(job.hrEmail) : false;
        const companySent = await isCompanySent(job.company);

        if (hrEmailSent) {
          console.log(`  ⏭️ Email already sent: ${job.hrEmail}`);
          continue;
        }
        if (companySent) {
          console.log(`  ⏭️ Company already contacted: ${job.company}`);
          continue;
        }
        newJobs.push(job);
      }

      if (newJobs.length > 0) {
        // Add to queue
        await addJobsToQueue(newJobs);
        
        // STEP 3: Clear the newly added queue
        console.log(`\n📨 STEP 3: Processing all newly added jobs...`);
        await processJobQueue(true); // Clear all jobs
        
        const finalQueueSize = await getQueueSize();
        if (finalQueueSize > 0) {
          console.log(`\n⚠️ ${finalQueueSize} jobs remain in queue (failed to send, will retry on next scheduled run)`);
        } else {
          console.log(`\n✅ All jobs processed successfully!`);
        }
      } else {
        console.log('⚠️ All jobs already contacted.');
      }
    }

    // Show final stats
    const stats = await getJobStats();
    const remainingInQueue = await getQueueSize();
    
    console.log('\n' + '=' .repeat(60));
    console.log('📊 STARTUP RUN COMPLETE');
    console.log('=' .repeat(60));
    console.log(`  All time: Total ${stats.total} | Sent ${stats.sent} | Failed ${stats.failed}`);
    console.log(`  Queue: ${remainingInQueue} jobs pending`);
    console.log('=' .repeat(60) + '\n');

  } catch (error) {
    console.error('❌ Fatal error in initial startup run:', error.message);
  }
}

async function verifySetup() {
  console.log('🔧 Verifying setup...\n');

  // Check environment variables
  const requiredEnvVars = ['GEMINI_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];
  const missing = requiredEnvVars.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Check resume file
  try {
    await fs.access(RESUME_PATH);
    console.log('✅ Resume file found');
  } catch {
    console.error(`❌ Resume file not found at: ${RESUME_PATH}`);
    process.exit(1);
  }

  // Test SMTP connection
  try {
    await transporter.verify();
    console.log('✅ SMTP connection verified');
  } catch (error) {
    console.error('❌ SMTP connection failed:', error.message);
    process.exit(1);
  }

  // Check/create jobs.json
  try {
    await fs.access(JOBS_DB_PATH);
    const stats = await getJobStats();
    console.log(`✅ Jobs database found (${stats.total} jobs tracked)`);
  } catch {
    await saveJobsDb({ jobs: [], sentEmails: [], sentCompanies: [] });
    console.log('✅ Jobs database created');
  }

  // Check/create jobQueue.json
  const queueSize = await getQueueSize();
  if (queueSize > 0) {
    console.log(`✅ Job queue found (${queueSize} pending jobs)`);
  } else {
    console.log('✅ Job queue initialized (empty)');
  }

  console.log('✅ All checks passed!\n');
}

async function main() {
  await verifySetup();

  // Run initial startup sequence (clear queue + generate + clear queue)
  console.log('🎯 Running initial startup sequence...\n');
  await initialStartupRun();

  // Schedule daily at 11:00 AM IST
  cron.schedule('0 11 * * *', async () => {
    console.log('\n⏰ Scheduled run triggered at 11:00 AM IST');
    await runJobApplicationCycle(true);
  }, {
    scheduled: true,
    timezone: 'Asia/Kolkata'
  });

  console.log('\n✅ Initial run completed!');
  console.log('⏰ Scheduler active: Job application will run daily at 11:00 AM IST');
  console.log('🔄 Service is running in the background...\n');
}

main().catch(console.error);
