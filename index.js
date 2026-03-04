import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import nodemailer from 'nodemailer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RESUME_PATH = path.join(__dirname, 'resume.pdf');
const JOBS_DB_PATH = path.join(__dirname, 'jobs.json');
const QUEUE_PATH = path.join(__dirname, 'jobQueue.json');

// Rate limit: 12 emails per hour
const MAX_EMAILS_PER_RUN = 12;
const EMAIL_INTERVAL_MS = 1 * 60 * 1000; // 5 minutes between emails

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

// Email configuration from environment
const SENDER_EMAIL = process.env.SENDER_EMAIL || process.env.SMTP_USER;
const SENDER_NAME = process.env.SENDER_NAME || 'Job Applicant';

// Create email transporter (supports Gmail and other SMTP providers)
function createTransporter() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '587');
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

const transporter = createTransporter();

// JSON file database functions
async function loadJobsDb() {
  try {
    const data = await fs.readFile(JOBS_DB_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
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
  console.log(`📥 Added ${jobs.length} jobs to queue (Total: ${queue.length})`);
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

async function markJobSent(job, sentRecipients) {
  const db = await loadJobsDb();

  db.jobs.push({
    ...job,
    status: 'sent',
    sentAt: new Date().toISOString(),
    sentRecipients: sentRecipients.map(r => ({ name: r.name, title: r.title, email: r.email }))
  });

  for (const recipient of sentRecipients) {
    if (recipient.email) {
      db.sentEmails.push(recipient.email.toLowerCase());
    }
  }
  db.sentCompanies.push(job.company.toLowerCase());

  await saveJobsDb(db);
  console.log(`💾 Saved: ${job.company} (${sentRecipients.length} recipients)`);
}

async function markJobFailed(job, errorMessage) {
  const db = await loadJobsDb();

  db.jobs.push({
    ...job,
    status: 'failed',
    errorMessage,
    failedAt: new Date().toISOString()
  });
  db.sentCompanies.push(job.company.toLowerCase());

  await saveJobsDb(db);
  console.log(`💾 Marked failed: ${job.company}`);
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

// Upload resume to Gemini File API
async function uploadResume() {
  try {
    console.log('📄 Uploading resume to Gemini...');
    const uploadResult = await fileManager.uploadFile(RESUME_PATH, {
      mimeType: 'application/pdf',
      displayName: 'Resume',
    });
    console.log(`✅ Resume uploaded successfully`);
    return uploadResult.file;
  } catch (error) {
    console.error('❌ Failed to upload resume:', error.message);
    throw error;
  }
}

// Upload resume to Gemini
const resumeFile = await uploadResume();

function formatTargetArea(type) {
  const labels = {
    'indian_mid_startup': '🇮🇳 Indian Mid-Level Startup (Series A-C)',
    'foreign_startup': '🌍 Foreign/International Startup',
    'mnc': '🏢 MNC/Large Enterprise',
    'early_startup': '🚀 Early-Stage Startup (Seed/Pre-Seed)'
  };
  return labels[type] || type;
}

function scoreJob(job, profile) {
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
  const allSkills = [
    ...(profile.skills?.programmingLanguages || []),
    ...(profile.skills?.frameworks || []),
    ...(profile.skills?.databases || []),
    ...(profile.skills?.tools || []),
    ...(profile.skills?.other || [])
  ];

  let matchedSkills = 0;
  for (const skill of allSkills) {
    if (jobDescription.includes(skill.toLowerCase())) matchedSkills++;
  }
  score += matchedSkills * 15;

  // Funding stage bonus
  const funding = (job.fundingStage || '').toLowerCase();
  if (funding.includes('series b') || funding.includes('series c')) score += 20;
  else if (funding.includes('series a')) score += 15;

  return score;
}

function isWorkTypeAllowed(job) {
  const location = (job.location || '').toLowerCase();
  const workType = (job.workType || '').toLowerCase();
  const isKolkata = location.includes('kolkata') || location.includes('calcutta');

  if (isKolkata) {
    return true; // onsite, hybrid, remote all OK for Kolkata
  }
  return workType === 'remote' || workType === 'hybrid'; // outside Kolkata: no onsite
}

// Single Gemini call that extracts profile, analyzes resume, and finds jobs
async function analyzeAndFindJobs(resumeFile) {
  try {
    console.log('🤖 Calling Gemini API (profile + analysis + jobs)...');

    const sentCompanies = await getSentCompanies();
    const excludeSection = sentCompanies.length > 0
      ? `

STRICT EXCLUSION - DO NOT INCLUDE THESE COMPANIES (already contacted):
${sentCompanies.join(', ')}

DO NOT return any job from the above companies. Find NEW companies only.`
      : '';

    const prompt = `You are a resume parser, career advisor, and job search assistant. Analyze the attached resume PDF and perform ALL tasks in ONE response.

TASK 1: Extract candidate profile from the resume
TASK 2: Analyze the resume for ATS compatibility and career targeting
TASK 3: Search for matching job openings (last 24-48 hours) using Google Search
TASK 4: Find multiple contacts per company and generate a unique personalized cold email for each contact

${excludeSection}

Return ONLY a valid JSON object with this EXACT structure:
{
  "profile": {
    "name": "Full Name from resume",
    "email": "email@example.com",
    "phone": "+1234567890",
    "location": "City, Country",
    "linkedIn": "linkedin.com/in/username or null",
    "github": "github.com/username or null",
    "portfolio": "portfolio-url.com or null",
    "summary": "Brief professional summary based on resume (2-3 sentences)",
    "currentRole": "Current or most recent job title",
    "yearsOfExperience": 5,
    "skills": {
      "programmingLanguages": ["JavaScript", "TypeScript", "Python", "Go"],
      "frameworks": ["React", "Node.js", "Express", "Next.js"],
      "databases": ["PostgreSQL", "MongoDB", "Redis"],
      "tools": ["Docker", "Kubernetes", "AWS", "Git"],
      "other": ["System Design", "Microservices", "REST APIs"]
    },
    "experience": [
      {
        "company": "Company Name",
        "role": "Job Title",
        "duration": "Jan 2020 - Present",
        "highlights": ["Achievement 1 with metrics", "Achievement 2 with metrics"]
      }
    ],
    "education": [
      {
        "institution": "University Name",
        "degree": "Degree Name",
        "year": "2020"
      }
    ],
    "projects": [
      {
        "name": "Project Name",
        "description": "What the project does",
        "technologies": ["Tech1", "Tech2"],
        "url": "github.com/user/project or null"
      }
    ],
    "achievements": ["Quantified achievement 1", "Quantified achievement 2"],
    "certifications": ["Certification 1", "Certification 2"]
  },
  "analysis": {
    "atsScore": 50,
    "atsScoreBreakdown": {
      "keywords": 80,
      "formatting": 90,
      "experience": 85,
      "skills": 88
    },
    "targetAreas": {
      "bestFit": "indian_mid_startup",
      "ranking": [
        {"type": "indian_mid_startup", "fitScore": 90, "reason": "Strong relevant skills"},
        {"type": "foreign_startup", "fitScore": 85, "reason": "Good experience level"},
        {"type": "mnc", "fitScore": 70, "reason": "May need more enterprise experience"},
        {"type": "early_startup", "fitScore": 75, "reason": "Good for hands-on roles"}
      ]
    },
    "strengths": ["Strength 1", "Strength 2"],
    "improvements": ["Improvement 1", "Improvement 2"],
    "keywordsMissing": ["Keyword 1", "Keyword 2"],
    "recommendedJobTitles": ["Title 1", "Title 2", "Title 3"]
  },
  "jobs": [
    {
      "company": "Company Name",
      "role": "Job Title",
      "snippet": "Brief job description",
      "requirements": "Key requirements from job posting",
      "workType": "remote",
      "companyType": "foreign_startup",
      "isFamous": true,
      "fundingStage": "Series B",
      "location": "Remote",
      "recipients": [
        {
          "email": "cto@company.com",
          "name": "Jane Doe",
          "title": "CTO",
          "emailGuessed": false,
          "emailSubject": "Unique personalized subject for Jane as CTO",
          "emailBody": "Unique personalized body addressing Jane's perspective as CTO"
        },
        {
          "email": "john.smith@company.com",
          "name": "John Smith",
          "title": "Senior Engineer",
          "emailGuessed": true,
          "emailSubject": "Unique personalized subject for John as Senior Engineer",
          "emailBody": "Unique personalized body addressing John's perspective as Senior Engineer"
        }
      ]
    }
  ]
}

PROFILE EXTRACTION RULES:
- Extract ONLY programming languages/technologies as skills, NOT spoken languages (Bengali, Hindi, English are NOT programming skills)
- "programmingLanguages" should ONLY contain: JavaScript, TypeScript, Python, Go, Java, C++, Rust, etc.
- Spoken/human languages should be IGNORED completely
- Extract ACTUAL data from the resume PDF, don't make up information
- If a field is not found, use null or empty array
- Be accurate with names, emails, and contact information
- Extract ALL quantifiable achievements (numbers, percentages, dollar amounts)
- For yearsOfExperience, calculate from work history dates

JOB SEARCH RULES:
- Find 10-15 NEW jobs matching the candidate's ACTUAL tech stack from resume
- ONLY include jobs that match PROGRAMMING technologies found in the resume
- DO NOT include jobs requiring technologies not in the resume

CRITICAL EMAIL SEARCH RULES — TWO-STEP APPROACH:
- DO NOT find HR emails, hiring emails, or generic recruitment emails
- Find ALL of these people at each company if possible: CEO, CTO, Co-Founder, VP Engineering, Head of Engineering, Engineering Manager, Tech Lead, Team Lead, Senior Engineer, Staff Engineer, Principal Engineer
- Each person found = one entry in the recipients array with their OWN unique personalized email
- Aim for 2-4 contacts per company (verified or inferred)

STEP 1 — VERIFY (always try first for each person):
- Search company websites, LinkedIn profiles, GitHub, Twitter, company blogs, press releases
- If a publicly listed, confirmed email is found → set emailGuessed: false

STEP 2 — INFER (fallback if no verified email found for that person):
- First determine the company's email domain from ANY known source (another employee's visible email, website contact page, press release, etc.)
- For CEO / CTO / Co-Founder / VP-level (senior leadership): use firstname@companydomain.com
  Example: Deepinder Goyal at Zomato → deepinder@zomato.com
- For Engineering Manager / Tech Lead / Senior / Staff / Principal Engineer: use firstname.lastname@companydomain.com
  Example: Ankan Saha at Hoichoi → ankan.saha@hoichoi.tv
- Set emailGuessed: true for ALL inferred emails
- If you cannot determine the company's email domain at all, skip that person entirely
- If you cannot find the person's real name, skip that person entirely (do not guess names)

COMPANY PRIORITY (search in this order):
1. FAMOUS/TOP-TIER companies FIRST (Google, Meta, Amazon, Microsoft, Apple, Netflix, Stripe, Vercel, Supabase, Cloudflare, Figma, Notion, Linear, etc.)
2. WELL-FUNDED UNICORNS (Razorpay, Zerodha, CRED, Meesho, PhonePe, Swiggy, Zomato, Ola, Flipkart, etc.)
3. SERIES B/C STARTUPS with strong engineering culture
4. SERIES A STARTUPS only if above not available
5. Early-stage startups as last resort

WORK TYPE PRIORITY:
1. REMOTE positions (fully remote, work from anywhere) - HIGHEST PRIORITY
2. HYBRID positions (partial remote)
3. ON-SITE positions ONLY for jobs located in Kolkata, India
- For jobs OUTSIDE Kolkata: include REMOTE and HYBRID only, skip ON-SITE
- For jobs IN Kolkata: REMOTE, HYBRID, and ON-SITE are all acceptable

SEARCH STRATEGY FOR JOBS:
- First search for: "[tech stack from resume] jobs at [famous company names] remote 2026"
- Then search for: "[job title] remote jobs hiring now"
- Look for recent job postings (last 24-48 hours)
- Check company career pages, LinkedIn, Wellfound, levels.fyi

SEARCH STRATEGY FOR CONTACTS (CRITICAL):
- For each company, search for MULTIPLE contacts across all seniority levels
- Search: "[Company name] CTO email", "[Company name] VP Engineering email", "[Company name] senior engineer LinkedIn", "[Company name] tech lead email"
- Check: Company website team/about pages, LinkedIn profiles, GitHub profiles, Twitter/X, company blogs, press releases
- Target roles (in priority order): CEO, CTO, Co-Founder, VP Engineering, Head of Engineering, Engineering Manager, Tech Lead, Senior Engineer, Staff Engineer, Principal Engineer
- Aim for 2-4 contacts per company (mix of verified + inferred is fine)
- For each person: try verified email first (emailGuessed: false), then infer from domain pattern (emailGuessed: true)
- To find the domain: look for any employee email visible anywhere, or check the company website's contact/about page
- If you find 0 verified AND cannot determine the domain → set recipients to [] but STILL INCLUDE THE JOB
- Jobs with empty recipients array will be automatically skipped

EMAIL SUBJECT RULES (make it impossible NOT to open):
- The subject must be a shocking, provocative, witty punchline — NOT a boring "Application for X" line
- It should feel like breaking news, a confession, a dare, or something deeply personal to the recipient
- Tailor the subject to the recipient's title and company — make it feel like it was written ONLY for them
- Examples of the tone you MUST match (do not copy these exactly, generate fresh ones each time):
  * "I broke prod at 3 companies. Want me to break yours next?"
  * "Your engineers are leaving. I know why."
  * "I reverse-engineered your stack. We need to talk."
  * "Honestly, I should not be emailing you. But here we are."
  * "Your CTO said this was a bad idea. I'm doing it anyway."
  * "I found a bug in your hiring process. It's missing me."
  * "This is either the best or worst email you'll get today."
  * "I ghosted 3 offers to wait for the right team. Are you it?"
  * "Warning: reading this email may cause an urgent hiring decision."
- Never use: "Application for", "Job opportunity", "Referral request", "Reaching out about"
- Max 10 words. Punchy. Ruthless. Unmissable.

EMAIL BODY RULES (generate SEPARATELY and UNIQUELY for EACH recipient):
- Each recipient gets a FULLY UNIQUE email — never duplicate subject or body across recipients at the same company
- FIRST LINE: Acknowledge the wild subject with a brief, charming apology that makes them smile
  Example openers: "I know — that subject line was a lot. Forgive me. But you opened it, so we're already off to a great start."
  Or: "Yes, I know. The subject was dramatic. I owe you an apology and also a really good pitch — here's both."
  Or: "Okay, I'm sorry about the subject. Sort of. You opened it though, so let's make this worth your time."
- After the apology, pivot cleanly into the actual pitch — make it feel natural, not forced
- Address each person by name and tailor the angle to their specific title:
  * CEO/Founder: business impact, growth, execution mindset
  * CTO/VP Engineering: technical depth, architecture, engineering culture
  * Engineering Manager/Tech Lead: team collaboration, shipping velocity, mentorship
  * Senior/Staff/Principal Engineer: specific technologies, code quality, technical details
- Highlight 2-3 KEY achievements from the resume that resonate with THIS specific person's perspective
- MUST include a STRONG CALL TO ACTION asking for a referral
- Max 160 words total (including apology opener)
- Sign off with the candidate's actual name from the resume
- DO NOT make up achievements - only use what's in the resume
- The tone should be: confident, self-aware, slightly audacious — someone they WANT to work with

IMPORTANT:
- bestFit must be one of: "indian_mid_startup", "foreign_startup", "mnc", "early_startup"
- Every email subject and body must be UNIQUE per recipient — same company but different people = completely different emails
- All data must come from the actual resume PDF provided
- DO NOT confuse spoken languages with programming languages
- Return ALL matching jobs - even if you couldn't find contacts (set recipients to [] in that case)
- Jobs with empty recipients array will be automatically skipped
- Each email is a request for REFERRAL, not a job application
- The goal is to have each contact vouch for or refer the candidate to their team`;

    const model = genAI.getGenerativeModel({
      model: '	gemini-3-flash-preview',
      tools: [{ googleSearch: {} }],
    });

    const result = await model.generateContent([
      prompt,
      {
        fileData: {
          fileUri: resumeFile.uri,
          mimeType: resumeFile.mimeType,
        },
      },
    ]);

    const text = result.response.text();
    console.log('✅ Gemini response received');

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('⚠️ No valid JSON found in response');
      return { profile: null, analysis: null, jobs: [] };
    }

    const response = JSON.parse(jsonMatch[0]);

    // Display profile info
    if (response.profile) {
      const profile = response.profile;
      console.log('\n' + '═'.repeat(60));
      console.log('👤 PROFILE EXTRACTED');
      console.log('═'.repeat(60));
      console.log(`  📛 Name: ${profile.name}`);
      console.log(`  📧 Email: ${profile.email}`);
      console.log(`  💼 Current Role: ${profile.currentRole}`);
      console.log(`  ⏱️  Experience: ${profile.yearsOfExperience} years`);
      console.log(`  💻 Languages: ${profile.skills?.programmingLanguages?.join(', ') || 'N/A'}`);
      console.log(`  🛠️  Frameworks: ${profile.skills?.frameworks?.join(', ') || 'N/A'}`);
      console.log(`  🗄️  Databases: ${profile.skills?.databases?.join(', ') || 'N/A'}`);
      console.log(`  🔧 Tools: ${profile.skills?.tools?.join(', ') || 'N/A'}`);
      console.log('═'.repeat(60));
    }

    // Display ATS analysis
    if (response.analysis) {
      const analysis = response.analysis;
      console.log('\n' + '═'.repeat(60));
      console.log('📊 RESUME ANALYSIS REPORT');
      console.log('═'.repeat(60));

      // ATS Score with visual bar
      const atsScore = analysis.atsScore || 0;
      const filledBlocks = Math.round(atsScore / 10);
      const emptyBlocks = 10 - filledBlocks;
      const scoreBar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);
      console.log(`\n🎯 ATS Score: ${scoreBar} ${atsScore}/100`);

      if (analysis.atsScoreBreakdown) {
        console.log('\n📈 Breakdown:');
        console.log(`   🔑 Keywords:   ${analysis.atsScoreBreakdown.keywords}/100`);
        console.log(`   📝 Formatting: ${analysis.atsScoreBreakdown.formatting}/100`);
        console.log(`   💼 Experience: ${analysis.atsScoreBreakdown.experience}/100`);
        console.log(`   🛠️  Skills:     ${analysis.atsScoreBreakdown.skills}/100`);
      }

      console.log(`\n🎯 BEST TARGET: ${formatTargetArea(analysis.targetAreas?.bestFit)}`);
      if (analysis.targetAreas?.ranking) {
        console.log('\n🏆 Target Area Rankings:');
        analysis.targetAreas.ranking.forEach((target, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
          console.log(`   ${medal} ${formatTargetArea(target.type)}: ${target.fitScore}/100`);
          console.log(`      └─ ${target.reason}`);
        });
      }

      console.log('\n💪 STRENGTHS:');
      (analysis.strengths || []).forEach(s => console.log(`   ✅ ${s}`));

      console.log('\n📈 IMPROVEMENTS NEEDED:');
      (analysis.improvements || []).forEach(imp => console.log(`   ⚡ ${imp}`));

      console.log('\n🔑 MISSING KEYWORDS:');
      console.log(`   ${(analysis.keywordsMissing || []).join(', ')}`);

      console.log('\n💼 RECOMMENDED JOB TITLES:');
      console.log(`   ${(analysis.recommendedJobTitles || []).join(' • ')}`);

      console.log('\n' + '═'.repeat(60));
    }

    // Process jobs
    let jobs = response.jobs || [];
    const profile = response.profile || {};

    // Score and sort jobs
    jobs = jobs.map(job => ({
      ...job,
      score: scoreJob(job, profile)
    }));

    jobs.sort((a, b) => b.score - a.score);

    console.log(`\n📋 JOB RANKINGS:`);
    console.log('─'.repeat(60));
    jobs.forEach((job, i) => {
      const workIcon = job.workType === 'remote' ? '🌍' : job.workType === 'hybrid' ? '🏠' : '🏢';
      const recipients = job.recipients || [];
      const contactIcon = recipients.length > 0 ? '👔' : '❌';
      const rank = i < 3 ? ['🥇', '🥈', '🥉'][i] : `${i + 1}.`;
      console.log(`   ${rank} ${workIcon} ${contactIcon} [${job.score}pts] ${job.role} @ ${job.company} (${recipients.length} contacts)`);
      recipients.forEach(r => {
        const tag = r.emailGuessed ? '🔮 inferred' : '✅ verified';
        console.log(`      -> ${r.name || 'Unknown'} (${r.title || 'Contact'}) <${r.email}> [${tag}]`);
      });
    });
    console.log('─'.repeat(60));
    console.log(`   Legend: 🌍 Remote | 🏠 Hybrid | 🏢 Onsite | 👔 Contacts Found | ❌ No Contacts`);

    const jobsWithContacts = jobs.filter(j => j.recipients?.length > 0).length;
    const totalContacts = jobs.reduce((sum, j) => sum + (j.recipients?.length || 0), 0);
    const jobsWithoutContacts = jobs.length - jobsWithContacts;
    console.log(`\n✨ Found ${jobs.length} jobs, ${totalContacts} total contacts (${jobsWithoutContacts} jobs with no contacts will be skipped)`);

    return {
      profile: response.profile,
      analysis: response.analysis,
      jobs: jobs
    };

  } catch (error) {
    console.error('❌ Failed to analyze resume and find jobs:', error.message);
    return { profile: null, analysis: null, jobs: [] };
  }
}

async function sendEmail(recipients, subject, body, senderName) {
  const toList = Array.isArray(recipients) ? recipients.filter(Boolean) : [recipients];

  if (toList.length === 0) {
    throw new Error('No valid recipients');
  }

  try {
    const mailOptions = {
      from: `"${senderName}" <${SENDER_EMAIL}>`,
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
    console.log(`   ✉️  Email sent to: ${toList.join(', ')}`);

  } catch (error) {
    console.error(`   ❌ Failed to send email to ${toList.join(', ')}:`, error.message);
    throw error;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getLastRunTime() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

async function processJobQueue(senderName, clearAll = false) {
  const queueSize = await getQueueSize();

  if (queueSize === 0) {
    console.log('📭 Queue is empty. No pending jobs to process.');
    return 0;
  }

  console.log(`\n📬 Found ${queueSize} companies in queue. Processing...`);

  const queue = await loadQueue();
  const jobsToProcess = clearAll ? queue : queue.slice(0, MAX_EMAILS_PER_RUN);

  const totalEmails = jobsToProcess.reduce((sum, j) => sum + (j.recipients?.length || 0), 0);
  const totalDelayMs = Math.max(0, totalEmails - 1) * EMAIL_INTERVAL_MS;
  const estimatedMinutes = Math.round(totalDelayMs / 60000);

  if (clearAll) {
    console.log(`🔥 Processing ALL ${jobsToProcess.length} companies (${totalEmails} emails total)...`);
  } else {
    console.log(`📧 Processing ${jobsToProcess.length} companies (${totalEmails} emails, max ${MAX_EMAILS_PER_RUN}/run)...`);
  }
  console.log(`⏱️  Estimated time: ~${estimatedMinutes} minutes`);
  console.log('─'.repeat(60));

  let sentCount = 0;
  let failedCount = 0;
  let emailsSentThisRun = 0;

  for (let i = 0; i < jobsToProcess.length; i++) {
    const job = jobsToProcess[i];
    const workIcon = job.workType === 'remote' ? '🌍' : job.workType === 'hybrid' ? '🏠' : '🏢';
    const recipients = job.recipients || [];

    if (recipients.length === 0) {
      console.log(`\n⚠️ [${i + 1}/${jobsToProcess.length}] Skipping ${job.company} - No contacts in queue entry`);
      await removeJobFromQueue(0);
      continue;
    }

    console.log(`\n🏢 [${i + 1}/${jobsToProcess.length}] ${workIcon} ${job.role} @ ${job.company} — ${recipients.length} contact(s)`);
    console.log(`   📊 Score: ${job.score}`);

    const sentRecipients = [];

    for (let ri = 0; ri < recipients.length; ri++) {
      const recipient = recipients[ri];

      if (!recipient.email) {
        console.log(`   ⚠️  [${ri + 1}/${recipients.length}] Skipping ${recipient.name || 'unknown'} - No email`);
        continue;
      }

      const emailIcon = recipient.emailGuessed ? '🔮' : '✅';
      console.log(`\n   📨 [${ri + 1}/${recipients.length}] ${emailIcon} ${recipient.name || 'Unknown'} (${recipient.title || 'Contact'}) <${recipient.email}>${recipient.emailGuessed ? ' [inferred]' : ' [verified]'}`);

      try {
        const subject = recipient.emailSubject || `Application for ${job.role} at ${job.company}`;
        const body = (recipient.emailBody || '').replace(/\\n/g, '\n');

        if (!body) throw new Error('No email body generated');

        await sendEmail([recipient.email], subject, body, senderName);
        sentRecipients.push(recipient);
        emailsSentThisRun++;
        sentCount++;
        console.log(`      ✅ Sent!`);

      } catch (error) {
        console.error(`      ❌ Failed: ${error.message}`);
        failedCount++;
      }

      // Delay between recipients within the same company
      if (ri < recipients.length - 1) {
        console.log(`      ⏳ Waiting before next contact at ${job.company}...`);
        await delay(EMAIL_INTERVAL_MS);
      }
    }

    // Mark company done regardless of partial failures
    if (sentRecipients.length > 0) {
      await markJobSent(job, sentRecipients);
    } else {
      await markJobFailed(job, 'All recipient sends failed');
    }
    await removeJobFromQueue(0);

    // Delay between companies
    if (i < jobsToProcess.length - 1) {
      console.log(`\n   ⏳ Moving to next company...`);
      await delay(EMAIL_INTERVAL_MS);
    }

    // Rate limit check (only when not clearAll)
    if (!clearAll && emailsSentThisRun >= MAX_EMAILS_PER_RUN) {
      console.log(`\n⚠️ Rate limit reached (${emailsSentThisRun} emails). Stopping for this run.`);
      break;
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`📊 Queue Stats: ✅ Sent: ${sentCount} | ❌ Failed: ${failedCount}`);

  return sentCount;
}

async function runJobApplicationCycle() {
  console.log('\n' + '🚀'.repeat(20));
  console.log('🚀 STARTING JOB APPLICATION CYCLE');
  console.log('🚀'.repeat(20));
  console.log(`⏰ Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
  console.log(`📧 Rate limit: ${MAX_EMAILS_PER_RUN} emails/hour\n`);

  try {
    // Single Gemini call for everything
    const { profile, jobs } = await analyzeAndFindJobs(resumeFile);

    if (!profile) {
      console.log('❌ Failed to extract profile. Skipping this cycle.');
      return;
    }

    const senderName = profile.name || SENDER_NAME;
    console.log(`👤 Candidate: ${senderName}`);

    // Check if there are existing jobs in queue
    const queueSize = await getQueueSize();
    if (queueSize > 0) {
      console.log(`\n🔄 Processing existing queue (${queueSize} jobs pending)...`);
      const processedCount = await processJobQueue(senderName, false);

      if (processedCount >= MAX_EMAILS_PER_RUN) {
        console.log(`\n✅ Processed ${processedCount} jobs from queue. Max limit reached.`);
        console.log(`📝 Will process new jobs in next cycle.\n`);
        return;
      }
    }

    if (jobs.length === 0) {
      console.log('⚠️ No new jobs found. Skipping this cycle.');
      return;
    }

    console.log(`\n🔍 Filtering jobs...`);
    const newJobs = [];

    for (const job of jobs) {
      if (!job.recipients || job.recipients.length === 0) {
        console.log(`   ⏭️  Skip: No contacts found for ${job.company} - ${job.role}`);
        continue;
      }

      if (!isWorkTypeAllowed(job)) {
        console.log(`   ⏭️  Skip: On-site outside Kolkata - ${job.company} (${job.location})`);
        continue;
      }

      if (await isCompanySent(job.company)) {
        console.log(`   ⏭️  Skip: Already contacted ${job.company}`);
        continue;
      }

      // Filter out individual recipients already emailed
      const freshRecipients = [];
      for (const r of job.recipients) {
        if (await isEmailSent(r.email)) {
          console.log(`   ⏭️  Skip recipient: ${r.email} already emailed`);
        } else {
          freshRecipients.push(r);
        }
      }

      if (freshRecipients.length === 0) {
        console.log(`   ⏭️  Skip: All contacts at ${job.company} already emailed`);
        continue;
      }

      newJobs.push({ ...job, recipients: freshRecipients });
    }

    if (newJobs.length === 0) {
      console.log('⚠️ All jobs already contacted. Skipping this cycle.');
      return;
    }

    await addJobsToQueue(newJobs);

    console.log(`\n📨 Processing newly added jobs...`);
    await processJobQueue(senderName, false);

    const stats = await getJobStats();
    const remainingInQueue = await getQueueSize();

    console.log('\n' + '═'.repeat(60));
    console.log('📊 CYCLE STATS');
    console.log('═'.repeat(60));
    console.log(`   📈 All time: Total ${stats.total} | ✅ Sent ${stats.sent} | ❌ Failed ${stats.failed}`);
    console.log(`   📬 Queue: ${remainingInQueue} jobs pending`);
    console.log('═'.repeat(60));

    console.log('\n✨ Job application cycle completed!');
    console.log(`🕐 Last Run: ${getLastRunTime()}\n`);

  } catch (error) {
    console.error('💥 Fatal error in job application cycle:', error.message);
    console.log(`🕐 Last Run (Failed): ${getLastRunTime()}\n`);
  }
}

async function initialStartupRun() {
  console.log('\n' + '🎬'.repeat(20));
  console.log('🎬 INITIAL STARTUP RUN');
  console.log('🎬'.repeat(20));

  try {
    let senderName = SENDER_NAME; // Initialize with default/env SENDER_NAME

    // Process existing queue FIRST
    const initialQueueSize = await getQueueSize();
    if (initialQueueSize > 0) {
      console.log(`\n📋 Processing existing queue (${initialQueueSize} jobs)...`);
      await processJobQueue(senderName, true);

      const remainingAfterClear = await getQueueSize();
      if (remainingAfterClear > 0) {
        console.log(`⚠️ Warning: ${remainingAfterClear} jobs failed to send (will retry later)`);
      } else {
        console.log(`✅ Queue completely cleared!`);
      }
    } else {
      console.log(`\n📋 Queue is already empty. ✅`);
    }

    // Now, upload resume and call Gemini for new jobs
    const resumeFile = await uploadResume();

    // Single Gemini call for everything
    console.log('\n🔍 Analyzing resume and searching for jobs...');
    const { profile, jobs } = await analyzeAndFindJobs(resumeFile);

    if (!profile) {
      console.log('❌ Failed to extract profile. Cannot proceed.');
      return null;
    }

    // Update senderName if profile is successfully extracted
    senderName = profile.name || SENDER_NAME;

    if (jobs.length === 0) {
      console.log('\n⚠️ No new jobs found.');
    } else {
      console.log(`\n🔍 STEP 2: Filtering jobs...`);
      const newJobs = [];

      for (const job of jobs) {
        if (!job.recipients || job.recipients.length === 0) {
          console.log(`   ⏭️  Skip: No contacts found for ${job.company} - ${job.role}`);
          continue;
        }

        if (!isWorkTypeAllowed(job)) {
          console.log(`   ⏭️  Skip: On-site outside Kolkata - ${job.company} (${job.location})`);
          continue;
        }

        if (await isCompanySent(job.company)) {
          console.log(`   ⏭️  Skip: Already contacted ${job.company}`);
          continue;
        }

        // Filter out individual recipients already emailed
        const freshRecipients = [];
        for (const r of job.recipients) {
          if (await isEmailSent(r.email)) {
            console.log(`   ⏭️  Skip recipient: ${r.email} already emailed`);
          } else {
            freshRecipients.push(r);
          }
        }

        if (freshRecipients.length === 0) {
          console.log(`   ⏭️  Skip: All contacts at ${job.company} already emailed`);
          continue;
        }

        newJobs.push({ ...job, recipients: freshRecipients });
      }

      if (newJobs.length > 0) {
        await addJobsToQueue(newJobs);

        console.log(`\n📨 STEP 3: Processing all newly added jobs...`);
        await processJobQueue(senderName, true);

        const finalQueueSize = await getQueueSize();
        if (finalQueueSize > 0) {
          console.log(`\n⚠️ ${finalQueueSize} jobs remain in queue (will retry on next scheduled run)`);
        } else {
          console.log(`\n✅ All jobs processed successfully!`);
        }
      } else {
        console.log('⚠️ All jobs already contacted.');
      }
    }

    const stats = await getJobStats();
    const remainingInQueue = await getQueueSize();

    console.log('\n' + '═'.repeat(60));
    console.log('🎉 STARTUP RUN COMPLETE');
    console.log('═'.repeat(60));
    console.log(`   👤 Candidate: ${senderName}`);
    console.log(`   📈 All time: Total ${stats.total} | ✅ Sent ${stats.sent} | ❌ Failed ${stats.failed}`);
    console.log(`   📬 Queue: ${remainingInQueue} jobs pending`);
    console.log(`   🕐 Last Run: ${getLastRunTime()}`);
    console.log('═'.repeat(60) + '\n');

    return profile;

  } catch (error) {
    console.error('💥 Fatal error in initial startup run:', error.message);
    console.log(`🕐 Last Run (Failed): ${getLastRunTime()}\n`);
    return null;
  }
}

async function verifySetup() {
  console.log('\n' + '🔧'.repeat(20));
  console.log('🔧 VERIFYING SETUP');
  console.log('🔧'.repeat(20) + '\n');

  // Check environment variables
  const requiredEnvVars = ['GEMINI_API_KEY', 'SMTP_USER', 'SMTP_PASS'];
  const missing = requiredEnvVars.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(', ')}`);
    console.log('\n📋 Required environment variables:');
    console.log('   🔑 GEMINI_API_KEY - Google Gemini API key');
    console.log('   📧 SMTP_USER      - Email address (e.g., your-email@gmail.com)');
    console.log('   🔐 SMTP_PASS      - Email password or app password');
    console.log('\n📋 Optional environment variables:');
    console.log('   🌐 SMTP_HOST      - SMTP server (default: smtp.gmail.com)');
    console.log('   🔌 SMTP_PORT      - SMTP port (default: 587)');
    console.log('   🔒 SMTP_SECURE    - Use SSL (default: false, true for port 465)');
    console.log('   📤 SENDER_EMAIL   - From email (default: SMTP_USER)');
    console.log('   👤 SENDER_NAME    - From name (default: extracted from resume)');
    process.exit(1);
  }
  console.log('✅ Environment variables configured');

  // Check resume file
  try {
    await fs.access(RESUME_PATH);
    console.log('✅ Resume file found');
  } catch {
    console.error(`❌ Resume file not found at: ${RESUME_PATH}`);
    console.log('📝 Please place your resume as "resume.pdf" in the project root directory.');
    process.exit(1);
  }

  // Test SMTP connection
  try {
    await transporter.verify();
    console.log('✅ SMTP connection verified');
  } catch (error) {
    console.error('❌ SMTP connection failed:', error.message);
    console.log('\n📧 For Gmail, make sure to:');
    console.log('   1️⃣  Enable 2-Factor Authentication');
    console.log('   2️⃣  Create an App Password at https://myaccount.google.com/apppasswords');
    console.log('   3️⃣  Use the App Password as SMTP_PASS');
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

  // Check queue
  const queueSize = await getQueueSize();
  if (queueSize > 0) {
    console.log(`✅ Job queue found (${queueSize} pending jobs)`);
  } else {
    console.log('✅ Job queue initialized (empty)');
  }

  console.log('\n🎉 All checks passed!\n');
}

async function main() {
  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  🤖 AI JOB APPLICATION BOT                                 ║');
  console.log('║  Automated job search & application system                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  await verifySetup();

  const noCron = process.env.NO_CRON === 'true';

  if (noCron) {
    console.log('🔁 Mode: CONTINUOUS (NO_CRON=true) — cycles run back-to-back\n');

    // Continuous loop: initial run then keep cycling
    await initialStartupRun();

    while (true) {
      console.log('\n🔄 Starting next cycle immediately...');
      await runJobApplicationCycle();
    }
  } else {
    console.log('⏰ Mode: SCHEDULED (NO_CRON=false) — cron runs at fixed times\n');

    // Run initial startup sequence then hand off to cron
    console.log('🚀 Running initial startup sequence...\n');
    await initialStartupRun();

    const schedules = [
      { cron: '0 11 * * *', label: '11:00 AM IST' },
      { cron: '0 14 * * *', label: '2:00 PM IST' },
      { cron: '0 17 * * *', label: '5:00 PM IST' },
      { cron: '0 21 * * *', label: '9:00 PM IST' },
    ];

    schedules.forEach(({ cron: cronExpr, label }) => {
      cron.schedule(cronExpr, async () => {
        console.log(`\n⏰ Scheduled run triggered at ${label}`);
        await runJobApplicationCycle();
      }, {
        scheduled: true,
        timezone: 'Asia/Kolkata'
      });
    });

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  ✅ INITIAL RUN COMPLETED                                  ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  ⏰ Scheduler active! Job applications will run at:        ║');
    schedules.forEach(({ label }) => {
      console.log(`║     📅 ${label.padEnd(48)}║`);
    });
    console.log('║                                                            ║');
    console.log('║  🔄 Service is running in the background...               ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
  }
}

main().catch(console.error);
