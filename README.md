# AI Interview Workflows

Cloudflare Worker MVP for AI-led candidate screening.

It gives recruiters an admin panel, creates one Google Sheet tab per job, lets candidates upload or paste a resume, generates AI interview questions from resume plus JD plus market context, evaluates the answers, and logs the result.

If Google Sheets secrets are not ready, the app stores data in Cloudflare KV when the AI_INTERVIEW_KV binding is configured.

## Local setup

1. Install dependencies:

   npm install

2. Create .dev.vars:

   ADMIN_PASSWORD=admin
   SESSION_SECRET=replace-with-a-long-random-string
   OPENROUTER_API_KEY=your-openrouter-key
   GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@project.iam.gserviceaccount.com
   GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

3. Run locally:

   npm run dev

Open http://localhost:8787.

Default admin user is admin. The password comes from ADMIN_PASSWORD; use admin for quick local testing.

## Cloudflare secrets

Create the KV namespace first:

   npx wrangler kv namespace create AI_INTERVIEW_KV

Paste the returned id into wrangler.toml as a kv_namespaces binding.

Set these in Cloudflare Workers:

   wrangler secret put ADMIN_PASSWORD
   wrangler secret put SESSION_SECRET
   wrangler secret put OPENROUTER_API_KEY
   wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
   wrangler secret put GOOGLE_PRIVATE_KEY

Share the Google Sheet with the service account email as Editor.

The sheet ID is already configured:

   1aW0_18-qqExMoqwJw11kVoNe5ajsXmkaHULrQcC1VQo

## Deploy

   npm run deploy

## Flow

1. Recruiter logs in at /admin/login.
2. Recruiter creates a job and pastes the JD.
3. Candidate opens /jobs, selects an opening, uploads a resume, and completes the AI interview.
4. Recruiter sees candidate scores in /admin; Google Sheets receives the full details.
