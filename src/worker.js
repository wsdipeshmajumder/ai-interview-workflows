const JOBS_HEADER = [
  "job_id",
  "title",
  "department",
  "location",
  "positions",
  "estimated_minutes",
  "status",
  "sheet_title",
  "created_at",
  "jd",
  "market_context"
];

const APPLICATION_HEADER = [
  "submitted_at",
  "application_id",
  "candidate_name",
  "candidate_email",
  "candidate_phone",
  "resume_file",
  "score",
  "recommendation",
  "summary",
  "strengths",
  "risks",
  "follow_up_questions",
  "answers_json",
  "resume_text"
];

const SAMPLE_JD = [
  "Evaluate Model Outputs: Audit, score, and validate outputs from various Generative AI models and LLM tools to ensure operational accuracy and contextual relevance.",
  "Optimize Sales Workflows: Refine and test AI-driven pre-sales lead scoring, automated outreach drafting, and CRM data enrichment pipelines.",
  "Audit Post-Sales Automation: Quality-check AI-generated customer success logs, support responses, and client onboarding summaries to maintain quality standards.",
  "Validate Financial Workflows: Perform strict human-in-the-loop evaluations on AI-extracted data, automated bookkeeping categories, and financial reporting runs.",
  "Refine Prompt Frameworks: Develop, test, and iterate on prompt structures and instructions to minimize model errors and maximize workflow efficiency.",
  "Document Edge Cases: Track, categorize, and report model hallucinations, systematic processing errors, or performance degradation to the engineering team.",
  "Execute Task Pipelines: Manage highly granular data tagging, classification, and output ranking tasks within internal business operations.",
  "Enforce Data Compliance: Ensure all data handled during automated sales, support, and financial campaigns strictly complies with privacy, security, and governance policies.",
  "Establish Quality Benchmarks: Help design objective grading rubrics and performance metrics to track the operational ROI of integrated AI tools.",
  "Bridge Operations and Tech: Translate real-world business performance gaps from sales and finance teams into actionable feedback for technical developers."
].join("\n");

const memory = {
  jobs: null,
  applications: []
};

let cachedGoogleToken = null;

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error(error);
      return html(layout(env, "Error", errorView("Something went wrong. Check the Worker logs.")), 500);
    }
  }
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = trimPath(url.pathname);
  const method = request.method.toUpperCase();

  if (path === "/" && method === "GET") return redirect("/jobs");
  if (path === "/health" && method === "GET") {
    return json({ ok: true, storage: storageMode(env) });
  }
  if (path === "/jobs" && method === "GET") return listJobsPage(env);
  if (path.startsWith("/jobs/") && method === "GET") return jobDetailPage(env, path.split("/")[2]);
  if (path.startsWith("/jobs/") && path.endsWith("/start") && method === "POST") {
    return startInterview(request, env, path.split("/")[2]);
  }
  if (path === "/interview/answer" && method === "POST") return answerInterview(request, env);
  if (path === "/admin/login" && method === "GET") return html(loginPage(env, ""));
  if (path === "/admin/login" && method === "POST") return adminLogin(request, env);
  if (path === "/admin/logout" && method === "POST") return adminLogout();

  const admin = await getAdmin(request, env);
  if (path === "/admin" && method === "GET") {
    if (!admin) return redirect("/admin/login");
    return adminHomePage(env, admin);
  }
  if (path === "/admin/jobs/new" && method === "GET") {
    if (!admin) return redirect("/admin/login");
    return html(newJobPage(env, admin, {}, ""));
  }
  if (path === "/admin/jobs" && method === "POST") {
    if (!admin) return redirect("/admin/login");
    return createJobAction(request, env, admin);
  }
  if (path.startsWith("/admin/jobs/") && path.endsWith("/status") && method === "POST") {
    if (!admin) return redirect("/admin/login");
    return updateJobStatusAction(request, env, path.split("/")[3]);
  }
  if (path.startsWith("/admin/jobs/") && method === "GET") {
    if (!admin) return redirect("/admin/login");
    return adminJobPage(env, admin, path.split("/")[3]);
  }

  return html(layout(env, "Not found", errorView("Page not found.")), 404);
}

async function listJobsPage(env) {
  const jobs = (await readJobs(env)).filter(function(job) {
    return job.status === "active";
  });
  return html(layout(env, "Openings", jobsListView(jobs)));
}

async function jobDetailPage(env, jobId, message) {
  const job = await getJob(env, jobId);
  if (!job || job.status !== "active") return html(layout(env, "Unavailable", errorView("Opening unavailable.")), 404);
  return html(layout(env, job.title, jobDetailView(job, message || "")));
}

async function startInterview(request, env, jobId) {
  const job = await getJob(env, jobId);
  if (!job || job.status !== "active") return html(layout(env, "Unavailable", errorView("Opening unavailable.")), 404);

  const form = await request.formData();
  const candidate = {
    name: clean(form.get("name")),
    email: clean(form.get("email")),
    phone: clean(form.get("phone"))
  };
  const resumeFile = form.get("resumeFile");
  let resumeText = normalizeText(form.get("resumeText") || "", 14000);
  if (resumeText.length < 80 && resumeFile && typeof resumeFile.text === "function" && String(resumeFile.type || "").startsWith("text/")) {
    resumeText = normalizeText(await resumeFile.text(), 14000);
  }

  if (!candidate.name || !candidate.email) {
    return html(layout(env, job.title, jobDetailView(job, "Name and email are required.")), 400);
  }
  if (resumeText.length < 80) {
    return html(layout(env, job.title, jobDetailView(job, "Could not read enough resume text. Paste the resume text in the box and start again.")), 400);
  }

  const interview = await generateInterview(env, job, resumeText);
  const state = {
    id: id("int"),
    jobId: job.id,
    candidate: candidate,
    resumeFileName: resumeFile && resumeFile.name ? String(resumeFile.name).slice(0, 160) : "resume",
    resumeText: resumeText,
    questions: interview.questions,
    index: 0,
    answers: [],
    startedAt: new Date().toISOString(),
    aiNote: interview.note || ""
  };
  const token = await createSignedToken(env, state);
  return html(layout(env, "Interview", interviewView(job, state, token)));
}

async function answerInterview(request, env) {
  const form = await request.formData();
  const token = clean(form.get("token"));
  const answer = normalizeText(form.get("answer") || "", 6000);
  const state = await verifySignedToken(env, token);
  if (!state) return html(layout(env, "Expired", errorView("This interview session expired. Please start again.")), 400);
  const job = await getJob(env, state.jobId);
  if (!job) return html(layout(env, "Unavailable", errorView("Opening unavailable.")), 404);
  if (!answer) {
    const sameToken = await createSignedToken(env, state);
    return html(layout(env, "Interview", interviewView(job, state, sameToken, "Please enter an answer before continuing.")), 400);
  }

  const question = state.questions[state.index];
  state.answers[state.index] = {
    question: question.question,
    competency: question.competency,
    answer: answer,
    answeredAt: new Date().toISOString()
  };
  state.index += 1;

  if (state.index < state.questions.length) {
    const nextToken = await createSignedToken(env, state);
    return html(layout(env, "Interview", interviewView(job, state, nextToken)));
  }

  const evaluation = await evaluateInterview(env, job, state);
  const application = {
    id: id("app"),
    jobId: job.id,
    candidate: state.candidate,
    resumeFileName: state.resumeFileName,
    resumeText: state.resumeText,
    answers: state.answers,
    evaluation: evaluation,
    startedAt: state.startedAt,
    submittedAt: new Date().toISOString()
  };
  await appendApplication(env, job, application);
  return html(layout(env, "Submitted", completeView(job)));
}

async function adminLogin(request, env) {
  const form = await request.formData();
  const username = clean(form.get("username"));
  const password = clean(form.get("password"));
  const expectedUser = env.ADMIN_USER || "admin";
  const expectedPassword = env.ADMIN_PASSWORD || "admin";
  if (username !== expectedUser || password !== expectedPassword) {
    return html(loginPage(env, "Invalid admin credentials."), 401);
  }
  const cookie = await createAdminCookie(env, username, new URL(request.url).protocol === "https:");
  return redirect("/admin", { "Set-Cookie": cookie });
}

function adminLogout() {
  return redirect("/jobs", { "Set-Cookie": "admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
}

async function adminHomePage(env, admin) {
  const jobs = await readJobs(env);
  const counts = await getCandidateCounts(env, jobs);
  return html(layout(env, "Admin", adminHomeView(jobs, counts, storageMode(env), admin), { admin: admin }));
}

async function adminJobPage(env, admin, jobId) {
  const job = await getJob(env, jobId);
  if (!job) return html(layout(env, "Not found", errorView("Job not found."), { admin: admin }), 404);
  const applications = await readApplications(env, job);
  return html(layout(env, job.title, adminJobView(job, applications), { admin: admin }));
}

async function createJobAction(request, env, admin) {
  const form = await request.formData();
  const input = {
    title: clean(form.get("title")),
    department: clean(form.get("department")),
    location: clean(form.get("location")),
    positions: Number(form.get("positions") || 1),
    estimatedMinutes: Number(form.get("estimatedMinutes") || 25),
    status: clean(form.get("status")) || "active",
    jd: normalizeText(form.get("jd") || "", 12000),
    marketContext: normalizeText(form.get("marketContext") || env.DEFAULT_MARKET_CONTEXT || "", 4000)
  };
  if (!input.title || !input.jd) {
    return html(newJobPage(env, admin, input, "Title and JD are required."), 400);
  }
  const job = await createJob(env, input);
  return redirect("/admin/jobs/" + encodeURIComponent(job.id));
}

async function updateJobStatusAction(request, env, jobId) {
  const form = await request.formData();
  await updateJobStatus(env, jobId, clean(form.get("status")) || "active");
  return redirect("/admin/jobs/" + encodeURIComponent(jobId));
}

function layout(env, title, body, options) {
  const admin = options && options.admin;
  const appName = env.APP_NAME || "AI Interview Workflows";
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>" + escapeHtml(title) + " | " + escapeHtml(appName) + "</title>",
    "<style>" + css() + "</style>",
    "</head>",
    "<body>",
    "<header class=\"topbar\">",
    "<a class=\"brand\" href=\"/jobs\">" + escapeHtml(appName) + "</a>",
    "<nav>",
    "<a href=\"/jobs\">Openings</a>",
    admin ? "<a href=\"/admin\">Admin</a><form method=\"post\" action=\"/admin/logout\"><button class=\"ghost\" type=\"submit\">Logout</button></form>" : "<a href=\"/admin/login\">Admin</a>",
    "</nav>",
    "</header>",
    "<main class=\"shell\">" + body + "</main>",
    "</body>",
    "</html>"
  ].join("");
}

function jobsListView(jobs) {
  const cards = jobs.length ? jobs.map(function(job) {
    return [
      "<article class=\"job-card\">",
      "<div>",
      "<p class=\"eyebrow\">" + escapeHtml(job.department || "Open role") + "</p>",
      "<h2>" + escapeHtml(job.title) + "</h2>",
      "<p class=\"muted\">" + escapeHtml(job.location || "Location not specified") + " · " + escapeHtml(job.positions) + " position" + (Number(job.positions) === 1 ? "" : "s") + " · " + escapeHtml(job.estimatedMinutes) + " min</p>",
      "</div>",
      "<a class=\"button\" href=\"/jobs/" + encodeURIComponent(job.id) + "\">Apply</a>",
      "</article>"
    ].join("");
  }).join("") : "<section class=\"empty\"><h1>No active openings yet</h1><p>Ask the recruiter to create a job from the admin panel.</p></section>";
  return [
    "<section class=\"page-head\">",
    "<h1>Openings</h1>",
    "<p>Select a role, upload the resume, and complete the screening interview.</p>",
    "</section>",
    "<div class=\"stack\">" + cards + "</div>"
  ].join("");
}

function jobDetailView(job, message) {
  return [
    message ? "<div class=\"flash\">" + escapeHtml(message) + "</div>" : "",
    "<section class=\"split\">",
    "<div>",
    "<p class=\"eyebrow\">" + escapeHtml(job.department || "Open role") + "</p>",
    "<h1>" + escapeHtml(job.title) + "</h1>",
    "<p class=\"muted\">" + escapeHtml(job.location || "Location not specified") + " · " + escapeHtml(job.positions) + " position" + (Number(job.positions) === 1 ? "" : "s") + " · " + escapeHtml(job.estimatedMinutes) + " min interview</p>",
    "<div class=\"jd\">" + formatText(job.jd) + "</div>",
    "</div>",
    "<aside class=\"panel\">",
    "<h2>Start interview</h2>",
    "<form id=\"applyForm\" method=\"post\" action=\"/jobs/" + encodeURIComponent(job.id) + "/start\" enctype=\"multipart/form-data\" class=\"form\">",
    "<label>Name<input name=\"name\" required autocomplete=\"name\"></label>",
    "<label>Email<input name=\"email\" type=\"email\" required autocomplete=\"email\"></label>",
    "<label>Phone<input name=\"phone\" autocomplete=\"tel\"></label>",
    "<label>Resume file<input id=\"resumeFile\" name=\"resumeFile\" type=\"file\" accept=\".pdf,.docx,.txt,.md,.rtf\" required></label>",
    "<label>Resume text<textarea id=\"resumeText\" name=\"resumeText\" rows=\"8\" required placeholder=\"This fills automatically for PDF, DOCX, or text resumes. If it does not, paste the resume text here.\"></textarea></label>",
    "<p id=\"resumeStatus\" class=\"hint\">Upload a text-based PDF, DOCX, or TXT resume.</p>",
    "<button id=\"startButton\" class=\"button full\" type=\"submit\">Start AI interview</button>",
    "</form>",
    "</aside>",
    "</section>",
    resumeExtractScripts()
  ].join("");
}

function interviewView(job, state, token, message) {
  const current = state.index + 1;
  const total = state.questions.length;
  const question = state.questions[state.index];
  const pct = Math.max(3, Math.round((state.index / total) * 100));
  return [
    message ? "<div class=\"flash\">" + escapeHtml(message) + "</div>" : "",
    state.aiNote ? "<div class=\"flash\">" + escapeHtml(state.aiNote) + "</div>" : "",
    "<section class=\"interview\">",
    "<div class=\"progress\"><span style=\"width:" + pct + "%\"></span></div>",
    "<p class=\"eyebrow\">" + escapeHtml(job.title) + " · Question " + current + " of " + total + "</p>",
    "<h1>" + escapeHtml(question.question) + "</h1>",
    "<p class=\"muted\">" + escapeHtml(question.competency || "Interview signal") + " · " + escapeHtml(question.timeBoxMinutes || 3) + " min</p>",
    "<form method=\"post\" action=\"/interview/answer\" class=\"form\">",
    "<input type=\"hidden\" name=\"token\" value=\"" + escapeHtml(token) + "\">",
    "<label>Your answer<textarea name=\"answer\" rows=\"9\" required autofocus></textarea></label>",
    "<button class=\"button\" type=\"submit\">" + (current === total ? "Submit interview" : "Next question") + "</button>",
    "</form>",
    "</section>"
  ].join("");
}

function completeView(job) {
  return [
    "<section class=\"complete\">",
    "<p class=\"eyebrow\">" + escapeHtml(job.title) + "</p>",
    "<h1>Interview submitted</h1>",
    "<p>Your responses have been recorded. The recruiter will review the AI screening result and continue with the next round.</p>",
    "<a class=\"button\" href=\"/jobs\">Back to openings</a>",
    "</section>"
  ].join("");
}

function loginPage(env, message) {
  return layout(env, "Admin login", [
    message ? "<div class=\"flash\">" + escapeHtml(message) + "</div>" : "",
    "<section class=\"auth panel\">",
    "<h1>Admin login</h1>",
    "<form method=\"post\" action=\"/admin/login\" class=\"form\">",
    "<label>Username<input name=\"username\" required autocomplete=\"username\" value=\"admin\"></label>",
    "<label>Password<input name=\"password\" type=\"password\" required autocomplete=\"current-password\"></label>",
    "<button class=\"button full\" type=\"submit\">Login</button>",
    "</form>",
    "</section>"
  ].join(""));
}

function adminHomeView(jobs, counts, mode) {
  const rows = jobs.map(function(job) {
    return [
      "<tr>",
      "<td><a href=\"/admin/jobs/" + encodeURIComponent(job.id) + "\">" + escapeHtml(job.title) + "</a></td>",
      "<td><span class=\"pill\">" + escapeHtml(job.status) + "</span></td>",
      "<td>" + escapeHtml(job.positions) + "</td>",
      "<td>" + escapeHtml(counts[job.id] || 0) + "</td>",
      "<td>" + escapeHtml(job.sheetTitle || "-") + "</td>",
      "</tr>"
    ].join("");
  }).join("");
  const durable = mode === "google-sheets" || mode === "cloudflare-kv";
  return [
    durable ? "" : "<div class=\"flash\">Google Sheets and KV are not configured. Data is using a temporary Worker memory fallback.</div>",
    "<section class=\"page-head row\">",
    "<div><h1>Admin</h1><p>Storage: " + escapeHtml(mode) + "</p></div>",
    "<a class=\"button\" href=\"/admin/jobs/new\">New job</a>",
    "</section>",
    "<div class=\"table-wrap\"><table>",
    "<thead><tr><th>Job</th><th>Status</th><th>Positions</th><th>Candidates</th><th>Sheet tab</th></tr></thead>",
    "<tbody>" + (rows || "<tr><td colspan=\"5\">No jobs yet.</td></tr>") + "</tbody>",
    "</table></div>"
  ].join("");
}

function newJobPage(env, admin, defaults, message) {
  return layout(env, "New job", [
    message ? "<div class=\"flash\">" + escapeHtml(message) + "</div>" : "",
    "<section class=\"page-head\"><h1>Create job</h1><p>Each job creates one tab in the configured Google Sheet.</p></section>",
    "<form method=\"post\" action=\"/admin/jobs\" class=\"form wide\">",
    "<div class=\"grid-2\">",
    "<label>Title<input name=\"title\" required value=\"" + escapeHtml(defaults.title || "Analyst - AI Workflows") + "\"></label>",
    "<label>Department<input name=\"department\" value=\"" + escapeHtml(defaults.department || "Operations") + "\"></label>",
    "<label>Location<input name=\"location\" value=\"" + escapeHtml(defaults.location || "Kolkata / On-site") + "\"></label>",
    "<label>Positions<input name=\"positions\" type=\"number\" min=\"1\" value=\"" + escapeHtml(defaults.positions || 5) + "\"></label>",
    "<label>Estimated minutes<input name=\"estimatedMinutes\" type=\"number\" min=\"10\" max=\"90\" value=\"" + escapeHtml(defaults.estimatedMinutes || 25) + "\"></label>",
    "<label>Status<select name=\"status\"><option value=\"active\">active</option><option value=\"closed\">closed</option></select></label>",
    "</div>",
    "<label>Job description<textarea name=\"jd\" rows=\"12\" required>" + escapeHtml(defaults.jd || SAMPLE_JD) + "</textarea></label>",
    "<label>Market trends and interviewer guidance<textarea name=\"marketContext\" rows=\"5\">" + escapeHtml(defaults.marketContext || env.DEFAULT_MARKET_CONTEXT || "") + "</textarea></label>",
    "<button class=\"button\" type=\"submit\">Create job</button>",
    "</form>"
  ].join(""), { admin: admin });
}

function adminJobView(job, applications) {
  const rows = applications.map(function(application) {
    const ev = application.evaluation || {};
    return [
      "<tr>",
      "<td>" + escapeHtml(application.candidate.name || "") + "</td>",
      "<td>" + escapeHtml(application.candidate.email || "") + "</td>",
      "<td>" + escapeHtml(application.candidate.phone || "") + "</td>",
      "<td><strong>" + escapeHtml(ev.score || "") + "</strong></td>",
      "<td>" + escapeHtml(ev.recommendation || "") + "</td>",
      "<td>" + escapeHtml(ev.summary || "") + "</td>",
      "<td>" + escapeHtml(application.submittedAt || "") + "</td>",
      "</tr>"
    ].join("");
  }).join("");
  return [
    "<section class=\"page-head row\">",
    "<div><p class=\"eyebrow\">" + escapeHtml(job.status) + "</p><h1>" + escapeHtml(job.title) + "</h1><p>" + escapeHtml(job.sheetTitle || "") + "</p></div>",
    "<form method=\"post\" action=\"/admin/jobs/" + encodeURIComponent(job.id) + "/status\" class=\"status-form\">",
    "<select name=\"status\"><option value=\"active\"" + (job.status === "active" ? " selected" : "") + ">active</option><option value=\"closed\"" + (job.status === "closed" ? " selected" : "") + ">closed</option></select>",
    "<button class=\"button secondary\" type=\"submit\">Update</button>",
    "</form>",
    "</section>",
    "<section class=\"panel\"><h2>JD</h2><div class=\"jd compact\">" + formatText(job.jd) + "</div></section>",
    "<section class=\"section-gap\"><h2>Candidates</h2><div class=\"table-wrap\"><table>",
    "<thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Score</th><th>Recommendation</th><th>Summary</th><th>Submitted</th></tr></thead>",
    "<tbody>" + (rows || "<tr><td colspan=\"7\">No candidates yet.</td></tr>") + "</tbody>",
    "</table></div></section>"
  ].join("");
}

function errorView(message) {
  return "<section class=\"empty\"><h1>" + escapeHtml(message) + "</h1><a class=\"button\" href=\"/jobs\">Go to openings</a></section>";
}

function resumeExtractScripts() {
  return [
    "<script src=\"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js\"></script>",
    "<script src=\"https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js\"></script>",
    "<script>",
    "(function(){",
    "var fileInput=document.getElementById('resumeFile');",
    "var textArea=document.getElementById('resumeText');",
    "var status=document.getElementById('resumeStatus');",
    "var form=document.getElementById('applyForm');",
    "var button=document.getElementById('startButton');",
    "function setStatus(text,bad){status.textContent=text;status.className=bad?'hint bad':'hint';}",
    "function decodeEntities(text){var el=document.createElement('textarea');el.innerHTML=text;return el.value;}",
    "async function readPdf(file){if(!window.pdfjsLib){throw new Error('PDF reader did not load');}pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';var buffer=await file.arrayBuffer();var pdf=await pdfjsLib.getDocument({data:new Uint8Array(buffer)}).promise;var out=[];for(var i=1;i<=pdf.numPages;i++){var page=await pdf.getPage(i);var content=await page.getTextContent();out.push(content.items.map(function(item){return item.str||'';}).join(' '));}return out.join('\\n');}",
    "async function readDocx(file){if(!window.JSZip){throw new Error('DOCX reader did not load');}var buffer=await file.arrayBuffer();var zip=await JSZip.loadAsync(buffer);var entry=zip.file('word/document.xml');if(!entry){throw new Error('DOCX text not found');}var xml=await entry.async('string');var text=xml.replace(/<w:tab\\/>/g,' ').replace(/<\\/w:p>/g,'\\n').replace(/<[^>]+>/g,' ');return decodeEntities(text);}",
    "async function extract(file){var name=(file.name||'').toLowerCase();if(name.endsWith('.pdf')||file.type==='application/pdf'){return readPdf(file);}if(name.endsWith('.docx')){return readDocx(file);}return file.text();}",
    "fileInput.addEventListener('change',async function(){var file=fileInput.files&&fileInput.files[0];if(!file){return;}button.disabled=true;setStatus('Reading resume text...',false);try{var text=await extract(file);text=text.replace(/\\s+/g,' ').trim();textArea.value=text;if(text.length<80){setStatus('I could not extract enough text. Paste the resume text manually.',true);}else{setStatus('Resume text extracted. You can review it before starting.',false);}}catch(error){setStatus('Could not auto-read this file. Paste the resume text manually.',true);}button.disabled=false;});",
    "form.addEventListener('submit',function(event){if((textArea.value||'').trim().length<80){event.preventDefault();setStatus('Paste at least a short resume summary before starting.',true);textArea.focus();return;}button.disabled=true;button.textContent='Preparing interview...';});",
    "})();",
    "</script>"
  ].join("");
}

async function readJobs(env) {
  if (!hasGoogle(env)) return readFallbackJobs(env);
  await ensureJobsSheet(env);
  const rows = await valuesGet(env, quoteSheet("Jobs") + "!A2:K");
  return rows.filter(function(row) {
    return row[0] && row[1];
  }).map(rowToJob).sort(function(a, b) {
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
}

async function getJob(env, jobId) {
  const jobs = await readJobs(env);
  return jobs.find(function(job) {
    return job.id === jobId;
  });
}

async function createJob(env, input) {
  const job = {
    id: id("job"),
    title: input.title,
    department: input.department,
    location: input.location,
    positions: input.positions || 1,
    estimatedMinutes: input.estimatedMinutes || 25,
    status: input.status || "active",
    sheetTitle: safeSheetTitle(input.title) + " " + id("").slice(-6),
    createdAt: new Date().toISOString(),
    jd: input.jd,
    marketContext: input.marketContext
  };
  if (!hasGoogle(env)) {
    const jobs = await readFallbackJobs(env);
    jobs.unshift(job);
    await writeFallbackJobs(env, jobs);
    return job;
  }
  await ensureJobsSheet(env);
  await ensureApplicationSheet(env, job.sheetTitle);
  await appendRows(env, quoteSheet("Jobs") + "!A1", [jobToRow(job)]);
  return job;
}

async function updateJobStatus(env, jobId, status) {
  const jobs = await readJobs(env);
  const job = jobs.find(function(item) {
    return item.id === jobId;
  });
  if (!job) return null;
  job.status = status;
  if (!hasGoogle(env)) {
    await writeFallbackJobs(env, jobs);
    return job;
  }
  const values = [JOBS_HEADER].concat(jobs.map(jobToRow));
  await valuesUpdate(env, quoteSheet("Jobs") + "!A1:K", values);
  return job;
}

async function readApplications(env, job) {
  if (!hasGoogle(env)) {
    return readFallbackApplications(env, job.id);
  }
  await ensureApplicationSheet(env, job.sheetTitle);
  const rows = await valuesGet(env, quoteSheet(job.sheetTitle) + "!A2:N");
  return rows.filter(function(row) {
    return row[1];
  }).map(function(row) {
    return {
      submittedAt: row[0] || "",
      id: row[1] || "",
      jobId: job.id,
      candidate: {
        name: row[2] || "",
        email: row[3] || "",
        phone: row[4] || ""
      },
      resumeFileName: row[5] || "",
      evaluation: {
        score: Number(row[6] || 0),
        recommendation: row[7] || "",
        summary: row[8] || "",
        strengths: splitList(row[9]),
        risks: splitList(row[10]),
        followUpQuestions: splitList(row[11])
      },
      answers: safeJson(row[12], []),
      resumeText: row[13] || ""
    };
  }).sort(function(a, b) {
    return String(b.submittedAt).localeCompare(String(a.submittedAt));
  });
}

async function appendApplication(env, job, application) {
  if (!hasGoogle(env)) {
    const applications = await readFallbackApplications(env, job.id);
    applications.unshift(application);
    await writeFallbackApplications(env, job.id, applications);
    return;
  }
  await ensureApplicationSheet(env, job.sheetTitle);
  await appendRows(env, quoteSheet(job.sheetTitle) + "!A1", [applicationToRow(application)]);
}

async function getCandidateCounts(env, jobs) {
  const counts = {};
  await Promise.all(jobs.map(async function(job) {
    const applications = await readApplications(env, job);
    counts[job.id] = applications.length;
  }));
  return counts;
}

async function readFallbackJobs(env) {
  if (env.AI_INTERVIEW_KV) {
    const stored = await env.AI_INTERVIEW_KV.get("jobs", "json");
    if (stored && Array.isArray(stored) && stored.length) return stored;
    const sample = memoryJobs();
    await env.AI_INTERVIEW_KV.put("jobs", JSON.stringify(sample));
    return sample;
  }
  return memoryJobs();
}

async function writeFallbackJobs(env, jobs) {
  memory.jobs = jobs;
  if (env.AI_INTERVIEW_KV) await env.AI_INTERVIEW_KV.put("jobs", JSON.stringify(jobs));
}

async function readFallbackApplications(env, jobId) {
  if (env.AI_INTERVIEW_KV) {
    const stored = await env.AI_INTERVIEW_KV.get("applications:" + jobId, "json");
    return Array.isArray(stored) ? stored : [];
  }
  return memory.applications.filter(function(app) {
    return app.jobId === jobId;
  });
}

async function writeFallbackApplications(env, jobId, applications) {
  memory.applications = memory.applications.filter(function(app) {
    return app.jobId !== jobId;
  }).concat(applications);
  if (env.AI_INTERVIEW_KV) await env.AI_INTERVIEW_KV.put("applications:" + jobId, JSON.stringify(applications));
}

function memoryJobs() {
  if (!memory.jobs) {
    memory.jobs = [{
      id: "job_sample_ai_workflows",
      title: "Analyst - AI Workflows",
      department: "Operations",
      location: "Kolkata / On-site",
      positions: 5,
      estimatedMinutes: 25,
      status: "active",
      sheetTitle: "Analyst AI Workflows",
      createdAt: new Date().toISOString(),
      jd: SAMPLE_JD,
      marketContext: "Focus on practical AI operations, model output review, prompt refinement, sales workflow QA, finance data validation, customer success automation, privacy, and documentation discipline."
    }];
  }
  return memory.jobs;
}

function rowToJob(row) {
  return {
    id: row[0] || "",
    title: row[1] || "",
    department: row[2] || "",
    location: row[3] || "",
    positions: Number(row[4] || 1),
    estimatedMinutes: Number(row[5] || 25),
    status: row[6] || "active",
    sheetTitle: row[7] || row[1] || "Job",
    createdAt: row[8] || "",
    jd: row[9] || "",
    marketContext: row[10] || ""
  };
}

function jobToRow(job) {
  return [
    job.id,
    job.title,
    job.department,
    job.location,
    job.positions,
    job.estimatedMinutes,
    job.status,
    job.sheetTitle,
    job.createdAt,
    job.jd,
    job.marketContext
  ];
}

function applicationToRow(application) {
  const evaluation = application.evaluation || {};
  return [
    application.submittedAt,
    application.id,
    application.candidate.name,
    application.candidate.email,
    application.candidate.phone,
    application.resumeFileName,
    evaluation.score,
    evaluation.recommendation,
    evaluation.summary,
    listCell(evaluation.strengths),
    listCell(evaluation.risks),
    listCell(evaluation.followUpQuestions),
    JSON.stringify(application.answers || []),
    normalizeText(application.resumeText || "", 12000)
  ];
}

async function ensureJobsSheet(env) {
  await ensureSheet(env, "Jobs");
  await ensureHeader(env, "Jobs", JOBS_HEADER);
}

async function ensureApplicationSheet(env, sheetTitle) {
  await ensureSheet(env, sheetTitle);
  await ensureHeader(env, sheetTitle, APPLICATION_HEADER);
}

async function ensureSheet(env, title) {
  const titles = await getSheetTitles(env);
  if (titles.indexOf(title) !== -1) return;
  await sheetsBatchUpdate(env, {
    requests: [{ addSheet: { properties: { title: title } } }]
  });
}

async function ensureHeader(env, title, header) {
  const rows = await valuesGet(env, quoteSheet(title) + "!1:1");
  const current = rows[0] || [];
  if (current.join("|") === header.join("|")) return;
  await valuesUpdate(env, quoteSheet(title) + "!1:1", [header]);
}

async function getSheetTitles(env) {
  const result = await sheetsFetch(env, "/v4/spreadsheets/" + encodeURIComponent(env.GOOGLE_SHEET_ID) + "?fields=sheets.properties.title", { method: "GET" });
  return (result.sheets || []).map(function(sheet) {
    return sheet.properties.title;
  });
}

async function valuesGet(env, range) {
  const result = await sheetsFetch(env, "/v4/spreadsheets/" + encodeURIComponent(env.GOOGLE_SHEET_ID) + "/values/" + encodeURIComponent(range), { method: "GET" });
  return result.values || [];
}

async function valuesUpdate(env, range, values) {
  return sheetsFetch(env, "/v4/spreadsheets/" + encodeURIComponent(env.GOOGLE_SHEET_ID) + "/values/" + encodeURIComponent(range) + "?valueInputOption=RAW", {
    method: "PUT",
    body: JSON.stringify({ values: values })
  });
}

async function appendRows(env, range, rows) {
  return sheetsFetch(env, "/v4/spreadsheets/" + encodeURIComponent(env.GOOGLE_SHEET_ID) + "/values/" + encodeURIComponent(range) + ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS", {
    method: "POST",
    body: JSON.stringify({ values: rows })
  });
}

async function sheetsBatchUpdate(env, body) {
  return sheetsFetch(env, "/v4/spreadsheets/" + encodeURIComponent(env.GOOGLE_SHEET_ID) + ":batchUpdate", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

async function sheetsFetch(env, path, options) {
  const token = await getGoogleAccessToken(env);
  const response = await fetch("https://sheets.googleapis.com" + path, {
    method: options.method || "GET",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: options.body
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error("Google Sheets API error " + response.status + ": " + body.slice(0, 300));
  }
  return response.json();
}

async function getGoogleAccessToken(env) {
  if (cachedGoogleToken && cachedGoogleToken.expiresAt > Date.now() + 60000) return cachedGoogleToken.token;
  const now = Math.floor(Date.now() / 1000);
  const assertion = await createGoogleJwt(env, now);
  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.set("assertion", assertion);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!response.ok) {
    throw new Error("Google token error " + response.status + ": " + (await response.text()).slice(0, 300));
  }
  const data = await response.json();
  cachedGoogleToken = {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
  };
  return cachedGoogleToken.token;
}

async function createGoogleJwt(env, now) {
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  });
  const input = header + "." + payload;
  const key = await importPrivateKey(env.GOOGLE_PRIVATE_KEY);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, textBytes(input));
  return input + "." + base64UrlBytes(signature);
}

async function importPrivateKey(privateKey) {
  const pem = String(privateKey || "").replace(/\\n/g, "\n").replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
  const binary = Uint8Array.from(atob(pem), function(char) {
    return char.charCodeAt(0);
  });
  return crypto.subtle.importKey("pkcs8", binary.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

async function generateInterview(env, job, resumeText) {
  const prompt = [
    "Create a structured screening interview for the candidate.",
    "Use the job description, resume, and market context together.",
    "Mix resume-specific, JD-specific, scenario, compliance, data quality, and workflow judgment questions.",
    "Avoid trivia and do not ask discriminatory questions.",
    "Return only JSON with this shape:",
    "{\"estimatedMinutes\":number,\"questions\":[{\"question\":\"string\",\"competency\":\"string\",\"expectedSignals\":\"string\",\"timeBoxMinutes\":number}]}",
    "Use 7 to 9 questions for a " + (job.estimatedMinutes || 25) + " minute interview.",
    "JOB TITLE:\n" + job.title,
    "JD:\n" + normalizeText(job.jd, 10000),
    "MARKET CONTEXT:\n" + normalizeText(job.marketContext || env.DEFAULT_MARKET_CONTEXT || "", 4000),
    "RESUME:\n" + normalizeText(resumeText, 12000)
  ].join("\n\n");
  try {
    const result = await openRouterJson(env, [
      { role: "system", content: "You are an expert interviewer for AI workflow analyst roles. Return only valid JSON." },
      { role: "user", content: prompt }
    ], 0.35);
    if (!result.questions || !Array.isArray(result.questions) || result.questions.length < 3) throw new Error("Too few questions returned");
    return {
      estimatedMinutes: Number(result.estimatedMinutes || job.estimatedMinutes || 25),
      questions: result.questions.slice(0, 10).map(function(q) {
        return {
          question: clean(q.question),
          competency: clean(q.competency || "General fit"),
          expectedSignals: clean(q.expectedSignals || ""),
          timeBoxMinutes: Number(q.timeBoxMinutes || 3)
        };
      })
    };
  } catch (error) {
    const fallback = fallbackInterview(job);
    fallback.note = "Using fallback questions because AI generation is unavailable: " + error.message;
    return fallback;
  }
}

async function evaluateInterview(env, job, state) {
  const prompt = [
    "Evaluate this candidate for the role.",
    "Score only from the resume and answers. Be strict, fair, and concise.",
    "Return only JSON with this shape:",
    "{\"score\":number,\"recommendation\":\"Strong Hire|Hire|Maybe|No Hire\",\"summary\":\"string\",\"strengths\":[\"string\"],\"risks\":[\"string\"],\"followUpQuestions\":[\"string\"],\"rubric\":[{\"area\":\"string\",\"score\":number,\"comment\":\"string\"}]}",
    "JOB:\n" + job.title,
    "JD:\n" + normalizeText(job.jd, 9000),
    "MARKET CONTEXT:\n" + normalizeText(job.marketContext || env.DEFAULT_MARKET_CONTEXT || "", 3000),
    "RESUME:\n" + normalizeText(state.resumeText, 10000),
    "Q AND A:\n" + JSON.stringify(state.answers)
  ].join("\n\n");
  try {
    const result = await openRouterJson(env, [
      { role: "system", content: "You are a strict but fair AI interview evaluator. Return only valid JSON." },
      { role: "user", content: prompt }
    ], 0.2);
    return {
      score: Number(result.score || 0),
      recommendation: clean(result.recommendation || "Maybe"),
      summary: clean(result.summary || ""),
      strengths: Array.isArray(result.strengths) ? result.strengths.map(clean) : [],
      risks: Array.isArray(result.risks) ? result.risks.map(clean) : [],
      followUpQuestions: Array.isArray(result.followUpQuestions) ? result.followUpQuestions.map(clean) : [],
      rubric: Array.isArray(result.rubric) ? result.rubric : []
    };
  } catch (_) {
    return fallbackEvaluation(job, state);
  }
}

async function openRouterJson(env, messages, temperature) {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not configured");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.OPENROUTER_API_KEY,
      "Content-Type": "application/json",
      "HTTP-Referer": env.APP_URL || "https://workers.dev",
      "X-Title": env.APP_NAME || "AI Interview Workflows"
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
      messages: messages,
      temperature: temperature,
      response_format: { type: "json_object" }
    })
  });
  if (!response.ok) throw new Error("OpenRouter " + response.status + ": " + (await response.text()).slice(0, 220));
  const data = await response.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return parseJsonObject(content || "");
}

function fallbackInterview(job) {
  return {
    estimatedMinutes: Number(job.estimatedMinutes || 25),
    questions: [
      { question: "Walk me through the parts of your experience that are most relevant to this role.", competency: "Resume relevance", expectedSignals: "Specific examples, tools, outcomes, and role fit.", timeBoxMinutes: 3 },
      { question: "How would you audit an AI-generated output for accuracy, relevance, and compliance?", competency: "AI output evaluation", expectedSignals: "Rubrics, evidence checks, severity labels, escalation, repeatability.", timeBoxMinutes: 4 },
      { question: "A sales team says AI lead scoring is producing poor priorities. What would you inspect first?", competency: "Sales workflow troubleshooting", expectedSignals: "Data quality, thresholds, false positives, CRM fields, feedback loop.", timeBoxMinutes: 4 },
      { question: "How would you validate AI-extracted finance data before it reaches a report?", competency: "Financial workflow validation", expectedSignals: "Source matching, reconciliation, sampling, exceptions, audit trail.", timeBoxMinutes: 4 },
      { question: "Describe a prompt or instruction you improved. What changed and how did you measure it?", competency: "Prompt refinement", expectedSignals: "Before and after examples, tests, failure categories, measurable gains.", timeBoxMinutes: 4 },
      { question: "How would you document hallucinations or systematic AI errors so engineering can act on them?", competency: "Operational documentation", expectedSignals: "Reproduction steps, inputs, expected vs actual, frequency, impact, priority.", timeBoxMinutes: 3 },
      { question: "What privacy or security checks matter when handling candidate, customer, sales, or finance data in AI workflows?", competency: "Data governance", expectedSignals: "PII handling, least privilege, masking, retention, consent, access control.", timeBoxMinutes: 3 },
      { question: "If selected, what would your first week plan look like for learning and improving this AI workflow operation?", competency: "Execution readiness", expectedSignals: "Structured onboarding, quick audits, stakeholders, first metrics.", timeBoxMinutes: 3 }
    ]
  };
}

function fallbackEvaluation(job, state) {
  const combined = state.answers.map(function(a) {
    return a.answer || "";
  }).join(" ").toLowerCase();
  const answered = state.answers.filter(function(a) {
    return (a.answer || "").trim().length > 20;
  }).length;
  const hits = ["audit", "rubric", "crm", "prompt", "privacy", "finance", "validation", "compliance", "spreadsheet", "metrics"].filter(function(term) {
    return combined.indexOf(term) !== -1;
  }).length;
  const score = Math.max(35, Math.min(78, answered * 7 + hits * 3 + Math.floor(combined.split(/\s+/).length / 35)));
  return {
    score: score,
    recommendation: score >= 70 ? "Maybe" : "Needs human review",
    summary: "Fallback score for " + job.title + ". OpenRouter evaluation was unavailable, so use this only as a screening aid.",
    strengths: ["Candidate completed the AI interview."],
    risks: ["AI scoring model was unavailable; human review is required."],
    followUpQuestions: ["Validate the candidate's answers in the human round."],
    rubric: []
  };
}

async function createSignedToken(env, data) {
  const payload = base64UrlString(JSON.stringify(data));
  const signature = await hmac(env, payload);
  return payload + "." + signature;
}

async function verifySignedToken(env, token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const expected = await hmac(env, parts[0]);
  if (expected !== parts[1]) return null;
  return JSON.parse(fromBase64Url(parts[0]));
}

async function createAdminCookie(env, username, secure) {
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  const token = await createSignedToken(env, { username: username, expiresAt: expiresAt });
  return "admin=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800" + (secure ? "; Secure" : "");
}

async function getAdmin(request, env) {
  const cookie = parseCookies(request.headers.get("Cookie") || "").admin;
  const data = await verifySignedToken(env, cookie);
  if (!data || data.expiresAt < Date.now()) return null;
  return { username: data.username };
}

async function hmac(env, value) {
  const secret = env.SESSION_SECRET || "dev-secret-change-me";
  const key = await crypto.subtle.importKey("raw", textBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, textBytes(value));
  return base64UrlBytes(signature);
}

function hasGoogle(env) {
  return Boolean(env.GOOGLE_SHEET_ID && env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY);
}

function storageMode(env) {
  if (hasGoogle(env)) return "google-sheets";
  if (env.AI_INTERVIEW_KV) return "cloudflare-kv";
  return "memory-fallback";
}

function html(body, status, headers) {
  return new Response(body, {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "text/html; charset=utf-8" }, headers || {})
  });
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function redirect(location, headers) {
  return new Response(null, {
    status: 303,
    headers: Object.assign({ Location: location }, headers || {})
  });
}

function trimPath(path) {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed || "/";
}

function id(prefix) {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const value = Array.from(bytes).map(function(byte) {
    return byte.toString(16).padStart(2, "0");
  }).join("");
  return (prefix || "id") + "_" + value;
}

function clean(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function normalizeText(value, limit) {
  return String(value == null ? "" : value).replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, limit || 18000);
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#039;");
}

function formatText(value) {
  return normalizeText(value || "", 20000).split("\n").map(function(line) {
    return line.trim();
  }).filter(Boolean).map(function(line) {
    return "<p>" + escapeHtml(line) + "</p>";
  }).join("");
}

function safeSheetTitle(value) {
  return clean(value || "Job").replace(/[\\/?*[\]:]/g, " ").slice(0, 52) || "Job";
}

function quoteSheet(title) {
  return "'" + String(title).replaceAll("'", "''") + "'";
}

function listCell(value) {
  return Array.isArray(value) ? value.join("; ") : clean(value);
}

function splitList(value) {
  return String(value || "").split(/;|\n/).map(function(item) {
    return item.trim();
  }).filter(Boolean);
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch (_) {
    return fallback;
  }
}

function parseJsonObject(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    const match = String(raw || "").match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI response did not contain JSON");
    return JSON.parse(match[0]);
  }
}

function parseCookies(header) {
  const out = {};
  header.split(";").forEach(function(part) {
    const index = part.indexOf("=");
    if (index === -1) return;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  });
  return out;
}

function textBytes(value) {
  return new TextEncoder().encode(value);
}

function base64UrlJson(value) {
  return base64UrlString(JSON.stringify(value));
}

function base64UrlString(value) {
  let binary = "";
  const bytes = textBytes(value);
  bytes.forEach(function(byte) {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlBytes(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  bytes.forEach(function(byte) {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, function(char) {
    return char.charCodeAt(0);
  });
  return new TextDecoder().decode(bytes);
}

function css() {
  return [
    ":root{--ink:#17202a;--muted:#667085;--line:#d9dee8;--surface:#f6f8fb;--panel:#fff;--brand:#0f766e;--brand-dark:#115e59;--accent:#b45309;--warn:#93370d}",
    "*{box-sizing:border-box}",
    "body{margin:0;color:var(--ink);background:var(--surface);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;letter-spacing:0}",
    "a{color:inherit}",
    ".topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:24px;padding:14px clamp(16px,4vw,44px);background:rgba(255,255,255,.94);border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}",
    ".brand{font-weight:800;text-decoration:none}",
    "nav{display:flex;align-items:center;gap:16px;color:var(--muted);font-size:14px}",
    "nav a,.ghost{color:var(--muted);text-decoration:none}.ghost{border:0;background:transparent;cursor:pointer;font:inherit;padding:0}",
    ".shell{width:min(1120px,calc(100% - 32px));margin:0 auto;padding:34px 0 56px}",
    ".page-head{margin-bottom:22px}.page-head h1,.split h1,.interview h1,.complete h1,.auth h1{margin:0 0 10px;font-size:clamp(28px,5vw,48px);line-height:1.03}",
    ".page-head p,.complete p,.muted,.hint{color:var(--muted)}.hint{font-size:13px;line-height:1.4}.hint.bad{color:var(--warn)}",
    ".row{display:flex;align-items:center;justify-content:space-between;gap:20px}.stack{display:grid;gap:14px}",
    ".job-card,.panel,.auth,.interview,.complete,.wide{background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 24px rgba(17,24,39,.05)}",
    ".job-card{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:22px}.job-card h2{margin:4px 0 6px;font-size:22px}",
    ".eyebrow{margin:0 0 8px;color:var(--accent);font-size:12px;font-weight:800;letter-spacing:0;text-transform:uppercase}",
    ".button{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 16px;border:1px solid var(--brand);border-radius:6px;background:var(--brand);color:white;font-weight:800;text-decoration:none;cursor:pointer}",
    ".button:hover{background:var(--brand-dark)}.button.secondary{background:white;color:var(--brand)}.button.full{width:100%}.button:disabled{opacity:.65;cursor:wait}",
    ".split{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:28px;align-items:start}.panel,.auth,.interview,.complete,.wide{padding:24px}.auth{width:min(420px,100%);margin:8vh auto 0}",
    ".form{display:grid;gap:16px}.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}",
    "label{display:grid;gap:7px;color:#344054;font-size:14px;font-weight:700}",
    "input,textarea,select{width:100%;min-height:42px;padding:10px 12px;border:1px solid #cbd5e1;border-radius:6px;background:white;color:var(--ink);font:inherit}textarea{resize:vertical}",
    "input:focus,textarea:focus,select:focus{outline:3px solid rgba(15,118,110,.18);border-color:var(--brand)}",
    ".jd{margin-top:18px;color:#344054;line-height:1.6}.jd.compact{max-height:300px;overflow:auto}",
    ".flash{margin:0 0 18px;padding:12px 14px;border:1px solid #fedf89;border-radius:6px;background:#fffaeb;color:#93370d}",
    ".progress{height:8px;border-radius:999px;overflow:hidden;background:#e6ebf2;margin-bottom:24px}.progress span{display:block;height:100%;background:var(--brand)}",
    ".table-wrap{overflow-x:auto;background:white;border:1px solid var(--line);border-radius:8px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:13px 14px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{background:#f8fafc;color:#475467;font-size:12px;text-transform:uppercase;letter-spacing:0}tr:last-child td{border-bottom:0}",
    ".status-form{display:flex;gap:10px;align-items:center}.empty{padding:46px 0;text-align:center}.complete{max-width:680px;margin:8vh auto 0;text-align:center}.section-gap{margin-top:24px}.pill{display:inline-flex;padding:3px 8px;border-radius:999px;background:#eef6f5;color:#115e59;font-weight:800;font-size:12px}",
    "@media(max-width:760px){.topbar,.row,.job-card,.status-form{align-items:stretch;flex-direction:column}nav{width:100%;justify-content:space-between}.split,.grid-2{grid-template-columns:1fr}.page-head h1,.split h1,.interview h1,.complete h1,.auth h1{font-size:32px}}"
  ].join("");
}
