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
  "market_context",
  "min_questions",
  "max_questions",
  "passing_score",
  "allow_retakes"
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
  "good",
  "bad",
  "fit_criteria",
  "follow_up_questions",
  "answers_json",
  "resume_text"
];

const MIN_INTERVIEW_MINUTES = 30;
const DEFAULT_MIN_QUESTIONS = 25;
const DEFAULT_MAX_QUESTIONS = 30;
const DEFAULT_PASSING_SCORE = 85;

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
  if (path === "/interview/start" && method === "POST") return launchInterview(request, env);
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
  if (path.startsWith("/admin/jobs/") && path.endsWith("/settings") && method === "POST") {
    if (!admin) return redirect("/admin/login");
    return updateJobSettingsAction(request, env, path.split("/")[3]);
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

  const settings = interviewSettings(job);
  if (!settings.allowRetakes && await hasPriorApplication(env, job, candidate)) {
    return html(layout(env, job.title, jobDetailView(job, duplicateAttemptMessage(candidate))), 409);
  }

  const pending = {
    id: id("prep"),
    type: "preflight",
    jobId: job.id,
    candidate: candidate,
    resumeFileName: resumeFile && resumeFile.name ? String(resumeFile.name).slice(0, 160) : "resume",
    resumeText: resumeText,
    minMinutes: settings.minMinutes,
    minQuestions: settings.minQuestions,
    maxQuestions: settings.maxQuestions,
    passingScore: settings.passingScore,
    allowRetakes: settings.allowRetakes,
    createdAt: new Date().toISOString()
  };
  const token = await createSignedToken(env, pending);
  return html(layout(env, "Before interview", preInterviewView(job, pending, token)));
}

async function launchInterview(request, env) {
  const form = await request.formData();
  const token = clean(form.get("token"));
  const pending = await verifySignedToken(env, token);
  if (!pending || pending.type !== "preflight") return html(layout(env, "Expired", errorView("This interview setup expired. Please start again.")), 400);
  const job = await getJob(env, pending.jobId);
  if (!job || job.status !== "active") return html(layout(env, "Unavailable", errorView("Opening unavailable.")), 404);

  const settings = interviewSettings(job, pending);
  if (!settings.allowRetakes && await hasPriorApplication(env, job, pending.candidate)) {
    return html(layout(env, job.title, jobDetailView(job, duplicateAttemptMessage(pending.candidate))), 409);
  }

  const interview = await generateInterview(env, job, pending.resumeText);
  const state = {
    id: id("int"),
    jobId: job.id,
    candidate: pending.candidate,
    resumeFileName: pending.resumeFileName,
    resumeText: pending.resumeText,
    questions: interview.questions,
    minMinutes: settings.minMinutes,
    minQuestions: settings.minQuestions,
    maxQuestions: settings.maxQuestions,
    passingScore: settings.passingScore,
    allowRetakes: settings.allowRetakes,
    index: 0,
    answers: [],
    startedAt: new Date().toISOString(),
    aiNote: interview.note || ""
  };
  const interviewToken = await createSignedToken(env, state);
  return html(layout(env, "Interview", interviewView(job, state, interviewToken)));
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
    complexity: question.complexity,
    answer: answer,
    answeredAt: new Date().toISOString()
  };
  state.index += 1;

  if (state.index < state.questions.length) {
    const nextToken = await createSignedToken(env, state);
    return html(layout(env, "Interview", interviewView(job, state, nextToken)));
  }

  if (elapsedInterviewMinutes(state) < interviewMinutes(job, state)) {
    state.extraProbeCount = Number(state.extraProbeCount || 0) + 1;
    state.questions.push(extraProbeQuestion(state.extraProbeCount));
    const nextToken = await createSignedToken(env, state);
    return html(layout(env, "Interview", interviewView(job, state, nextToken, "This is a " + interviewMinutes(job, state) + " minute minimum screen. Continue with the next deep probe.")));
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
    estimatedMinutes: settingNumber(form.get("estimatedMinutes"), MIN_INTERVIEW_MINUTES, MIN_INTERVIEW_MINUTES, 120),
    minQuestions: settingNumber(form.get("minQuestions"), DEFAULT_MIN_QUESTIONS, 1, 80),
    maxQuestions: settingNumber(form.get("maxQuestions"), DEFAULT_MAX_QUESTIONS, 1, 100),
    passingScore: settingNumber(form.get("passingScore"), DEFAULT_PASSING_SCORE, 50, 100),
    allowRetakes: settingBool(form.get("allowRetakes")),
    status: clean(form.get("status")) || "active",
    jd: normalizeText(form.get("jd") || "", 12000),
    marketContext: normalizeText(form.get("marketContext") || env.DEFAULT_MARKET_CONTEXT || "", 4000)
  };
  if (input.maxQuestions < input.minQuestions) input.maxQuestions = input.minQuestions;
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

async function updateJobSettingsAction(request, env, jobId) {
  const form = await request.formData();
  const input = {
    estimatedMinutes: settingNumber(form.get("estimatedMinutes"), MIN_INTERVIEW_MINUTES, MIN_INTERVIEW_MINUTES, 120),
    minQuestions: settingNumber(form.get("minQuestions"), DEFAULT_MIN_QUESTIONS, 1, 80),
    maxQuestions: settingNumber(form.get("maxQuestions"), DEFAULT_MAX_QUESTIONS, 1, 100),
    passingScore: settingNumber(form.get("passingScore"), DEFAULT_PASSING_SCORE, 50, 100),
    allowRetakes: settingBool(form.get("allowRetakes")),
    jd: normalizeText(form.get("jd") || "", 12000),
    marketContext: normalizeText(form.get("marketContext") || env.DEFAULT_MARKET_CONTEXT || "", 4000)
  };
  if (input.maxQuestions < input.minQuestions) input.maxQuestions = input.minQuestions;
  if (!input.jd) return redirect("/admin/jobs/" + encodeURIComponent(jobId));
  await updateJobSettings(env, jobId, input);
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
    const settings = interviewSettings(job);
    return [
      "<article class=\"job-card\">",
      "<div>",
      "<p class=\"eyebrow\">" + escapeHtml(job.department || "Open role") + "</p>",
      "<h2>" + escapeHtml(job.title) + "</h2>",
      "<p class=\"muted\">" + escapeHtml(job.location || "Location not specified") + " · " + escapeHtml(job.positions) + " position" + (Number(job.positions) === 1 ? "" : "s") + " · " + escapeHtml(settings.minMinutes) + " min · " + escapeHtml(questionRangeText(settings)) + "</p>",
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
  const settings = interviewSettings(job);
  return [
    message ? "<div class=\"flash\">" + escapeHtml(message) + "</div>" : "",
    "<section class=\"split\">",
    "<div>",
    "<p class=\"eyebrow\">" + escapeHtml(job.department || "Open role") + "</p>",
    "<h1>" + escapeHtml(job.title) + "</h1>",
    "<p class=\"muted\">" + escapeHtml(job.location || "Location not specified") + " · " + escapeHtml(job.positions) + " position" + (Number(job.positions) === 1 ? "" : "s") + " · minimum " + escapeHtml(settings.minMinutes) + " min · " + escapeHtml(questionRangeText(settings)) + "</p>",
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

function preInterviewView(job, pending, token) {
  const settings = interviewSettings(job, pending);
  const resumeWords = normalizeText(pending.resumeText || "", 14000).split(/\s+/).filter(Boolean).length;
  return [
    "<section class=\"preflight\">",
    "<div>",
    "<p class=\"eyebrow\">Before you begin</p>",
    "<h1>" + escapeHtml(job.title) + "</h1>",
    "<p class=\"lead\">This screen is not timed. Use it to get ready; the timed interview starts only after the checks pass and you click Begin.</p>",
    "</div>",
    "<div class=\"preflight-grid\">",
    "<section class=\"panel\">",
    "<h2>What to expect</h2>",
    "<ul class=\"clean-list\">",
    "<li>Minimum " + escapeHtml(settings.minMinutes) + " minutes once the interview starts.</li>",
    "<li>" + escapeHtml(questionRangeText(settings)) + " across baseline, intermediate, advanced, and pressure-test questions.</li>",
    "<li>Questions are based on your resume, the JD, and current AI workflow expectations.</li>",
    "<li>Answer with concrete examples, metrics, tools, tradeoffs, and failure cases. Generic answers are scored strictly.</li>",
    "<li>You cannot see the internal score after submission. The recruiter will review the AI analysis and get back to you.</li>",
    "</ul>",
    "</section>",
    "<section class=\"panel\">",
    "<h2>Tool check</h2>",
    "<div class=\"checks\">",
    "<p id=\"checkResume\" class=\"check-row pending\">Resume text captured (" + escapeHtml(resumeWords) + " words)</p>",
    "<p id=\"checkNetwork\" class=\"check-row pending\">Checking connection to interview server</p>",
    "<p id=\"checkBrowser\" class=\"check-row pending\">Checking browser storage and timer support</p>",
    "</div>",
    "<p id=\"checkHint\" class=\"hint\">Keep this tab open, stay on a stable connection, and avoid refreshing during the interview.</p>",
    "<form method=\"post\" action=\"/interview/start\" class=\"form\">",
    "<input type=\"hidden\" name=\"token\" value=\"" + escapeHtml(token) + "\">",
    "<button id=\"beginButton\" class=\"button full\" type=\"submit\" disabled>Run checks first</button>",
    "</form>",
    "<button id=\"retryChecks\" class=\"button secondary full\" type=\"button\">Retry checks</button>",
    "</section>",
    "</div>",
    "</section>",
    preflightScript(resumeWords)
  ].join("");
}

function preflightScript(resumeWords) {
  const resumeOk = resumeWords >= 20;
  const resumeText = "Resume text captured (" + resumeWords + " words)";
  return [
    "<script>",
    "(function(){",
    "var button=document.getElementById('beginButton');",
    "var retry=document.getElementById('retryChecks');",
    "var hint=document.getElementById('checkHint');",
    "function set(id,ok,text){var el=document.getElementById(id);el.className='check-row '+(ok?'ok':'bad');el.textContent=text;return ok;}",
    "async function run(){button.disabled=true;button.textContent='Running checks...';hint.textContent='Checking the tools needed for the timed interview.';var ok=true;",
    "ok=set('checkResume'," + JSON.stringify(resumeOk) + "," + JSON.stringify(resumeText) + ")&&ok;",
    "try{localStorage.setItem('aiInterviewCheck','1');localStorage.removeItem('aiInterviewCheck');ok=set('checkBrowser',typeof setInterval==='function','Browser storage and timer ready')&&ok;}catch(e){ok=set('checkBrowser',false,'Browser storage unavailable. Use a normal browser window.')&&ok;}",
    "try{var res=await fetch('/health',{cache:'no-store'});ok=set('checkNetwork',res.ok,'Connection to interview server ready')&&ok;}catch(e){ok=set('checkNetwork',false,'Connection check failed. Check internet and retry.')&&ok;}",
    "button.disabled=!ok;button.textContent=ok?'Begin timed interview':'Checks failed';hint.textContent=ok?'You are ready. The timer starts after you click Begin.':'Fix the failed check, then retry.';",
    "}",
    "retry.addEventListener('click',run);run();",
    "})();",
    "</script>"
  ].join("");
}

function interviewView(job, state, token, message) {
  const settings = interviewSettings(job, state);
  const current = state.index + 1;
  const total = state.questions.length;
  const question = state.questions[state.index];
  const pct = Math.max(3, Math.round((state.index / total) * 100));
  const isFinal = current === total;
  const endAt = new Date(new Date(state.startedAt).getTime() + settings.minMinutes * 60 * 1000).toISOString();
  const remainingSeconds = Math.max(0, Math.ceil((new Date(endAt).getTime() - Date.now()) / 1000));
  return [
    message ? "<div class=\"flash\">" + escapeHtml(message) + "</div>" : "",
    state.aiNote ? "<div class=\"flash\">" + escapeHtml(state.aiNote) + "</div>" : "",
    "<section class=\"interview\">",
    "<div class=\"progress\"><span style=\"width:" + pct + "%\"></span></div>",
    "<p class=\"eyebrow\">" + escapeHtml(job.title) + " · Question " + current + " of " + total + "</p>",
    "<h1>" + escapeHtml(question.question) + "</h1>",
    "<p class=\"muted\">" + escapeHtml(question.competency || "Interview signal") + " · " + escapeHtml(question.complexity || "mixed") + " · " + escapeHtml(question.timeBoxMinutes || 1) + " min · Minimum screen " + escapeHtml(settings.minMinutes) + " min</p>",
    isFinal ? "<p id=\"timerHint\" class=\"hint\">Final submission unlocks after the " + escapeHtml(settings.minMinutes) + " minute minimum.</p>" : "",
    "<form method=\"post\" action=\"/interview/answer\" class=\"form\">",
    "<input type=\"hidden\" name=\"token\" value=\"" + escapeHtml(token) + "\">",
    "<label>Your answer<textarea name=\"answer\" rows=\"9\" required autofocus></textarea></label>",
    "<button id=\"answerButton\" class=\"button\" type=\"submit\" " + (isFinal && remainingSeconds > 0 ? "disabled" : "") + ">" + (isFinal ? "Submit interview" : "Next question") + "</button>",
    "</form>",
    "</section>",
    isFinal ? interviewTimerScript(endAt) : ""
  ].join("");
}

function completeView(job) {
  return [
    "<section class=\"complete\">",
    "<p class=\"eyebrow\">" + escapeHtml(job.title) + "</p>",
    "<h1>Thank you. Your interview is submitted.</h1>",
    "<p>Your responses have been recorded successfully. The recruiter will review the screening analysis along with your resume and get back to you about the next round.</p>",
    "<div class=\"next-card\"><strong>What happens next</strong><p>No score is shown here. The hiring team receives the detailed AI analysis, strengths, risks, and fit criteria in the recruiter dashboard.</p></div>",
    "<a class=\"button\" href=\"/jobs\">Back to openings</a>",
    "</section>"
  ].join("");
}

function interviewTimerScript(endAt) {
  return [
    "<script>",
    "(function(){",
    "var endAt=new Date(" + JSON.stringify(endAt) + ").getTime();",
    "var button=document.getElementById('answerButton');",
    "var hint=document.getElementById('timerHint');",
    "function fmt(seconds){var m=Math.floor(seconds/60);var s=seconds%60;return m+'m '+String(s).padStart(2,'0')+'s';}",
    "function tick(){var remaining=Math.max(0,Math.ceil((endAt-Date.now())/1000));if(remaining>0){button.disabled=true;hint.textContent='Final submission unlocks in '+fmt(remaining)+'. Use the remaining time to deepen your answer.';}else{button.disabled=false;hint.textContent='Minimum interview time met. You can submit now.';clearInterval(timer);}}",
    "var timer=setInterval(tick,1000);tick();",
    "})();",
    "</script>"
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
    const settings = interviewSettings(job);
    return [
      "<tr>",
      "<td><a href=\"/admin/jobs/" + encodeURIComponent(job.id) + "\">" + escapeHtml(job.title) + "</a></td>",
      "<td><span class=\"pill\">" + escapeHtml(job.status) + "</span></td>",
      "<td>" + escapeHtml(job.positions) + "</td>",
      "<td>" + escapeHtml(settings.minMinutes) + " min / " + escapeHtml(questionRangeText(settings)) + "</td>",
      "<td>" + escapeHtml(settings.passingScore) + "+</td>",
      "<td>" + escapeHtml(settings.allowRetakes ? "Allowed" : "Blocked") + "</td>",
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
    "<thead><tr><th>Job</th><th>Status</th><th>Positions</th><th>Pacing</th><th>Pass</th><th>Retakes</th><th>Candidates</th><th>Sheet tab</th></tr></thead>",
    "<tbody>" + (rows || "<tr><td colspan=\"8\">No jobs yet.</td></tr>") + "</tbody>",
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
    "<label>Minimum minutes<input name=\"estimatedMinutes\" type=\"number\" min=\"30\" max=\"120\" value=\"" + escapeHtml(defaults.estimatedMinutes || MIN_INTERVIEW_MINUTES) + "\"></label>",
    "<label>Minimum questions<input name=\"minQuestions\" type=\"number\" min=\"1\" max=\"80\" value=\"" + escapeHtml(defaults.minQuestions || DEFAULT_MIN_QUESTIONS) + "\"></label>",
    "<label>Maximum questions<input name=\"maxQuestions\" type=\"number\" min=\"1\" max=\"100\" value=\"" + escapeHtml(defaults.maxQuestions || DEFAULT_MAX_QUESTIONS) + "\"></label>",
    "<label>Passing score<input name=\"passingScore\" type=\"number\" min=\"50\" max=\"100\" value=\"" + escapeHtml(defaults.passingScore || DEFAULT_PASSING_SCORE) + "\"></label>",
    "<label>Status<select name=\"status\"><option value=\"active\">active</option><option value=\"closed\">closed</option></select></label>",
    "<label class=\"check\"><input name=\"allowRetakes\" type=\"checkbox\" value=\"1\"" + (settingBool(defaults.allowRetakes) ? " checked" : "") + "> Allow repeat attempts for this opening</label>",
    "</div>",
    "<label>Job description<textarea name=\"jd\" rows=\"12\" required>" + escapeHtml(defaults.jd || SAMPLE_JD) + "</textarea></label>",
    "<label>Market trends and interviewer guidance<textarea name=\"marketContext\" rows=\"5\">" + escapeHtml(defaults.marketContext || env.DEFAULT_MARKET_CONTEXT || "") + "</textarea></label>",
    "<button class=\"button\" type=\"submit\">Create job</button>",
    "</form>"
  ].join(""), { admin: admin });
}

function adminJobView(job, applications) {
  const settings = interviewSettings(job);
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
      "<td>" + escapeHtml(compactList(ev.good || ev.strengths)) + "</td>",
      "<td>" + escapeHtml(compactList(ev.bad || ev.risks)) + "</td>",
      "<td>" + escapeHtml(compactFitCriteria(ev.fitCriteria)) + "</td>",
      "<td>" + escapeHtml(application.submittedAt || "") + "</td>",
      "</tr>"
    ].join("");
  }).join("");
  return [
    "<section class=\"page-head row\">",
    "<div><p class=\"eyebrow\">" + escapeHtml(job.status) + "</p><h1>" + escapeHtml(job.title) + "</h1><p>" + escapeHtml(job.sheetTitle || "") + " · " + escapeHtml(settings.minMinutes) + " min · " + escapeHtml(questionRangeText(settings)) + " · pass " + escapeHtml(settings.passingScore) + "+ · retakes " + escapeHtml(settings.allowRetakes ? "allowed" : "blocked") + "</p></div>",
    "<form method=\"post\" action=\"/admin/jobs/" + encodeURIComponent(job.id) + "/status\" class=\"status-form\">",
    "<select name=\"status\"><option value=\"active\"" + (job.status === "active" ? " selected" : "") + ">active</option><option value=\"closed\"" + (job.status === "closed" ? " selected" : "") + ">closed</option></select>",
    "<button class=\"button secondary\" type=\"submit\">Update</button>",
    "</form>",
    "</section>",
    "<section class=\"panel\"><h2>Interview controls</h2>",
    "<form method=\"post\" action=\"/admin/jobs/" + encodeURIComponent(job.id) + "/settings\" class=\"form\">",
    "<div class=\"grid-2\">",
    "<label>Minimum minutes<input name=\"estimatedMinutes\" type=\"number\" min=\"30\" max=\"120\" value=\"" + escapeHtml(settings.minMinutes) + "\"></label>",
    "<label>Minimum questions<input name=\"minQuestions\" type=\"number\" min=\"1\" max=\"80\" value=\"" + escapeHtml(settings.minQuestions) + "\"></label>",
    "<label>Maximum questions<input name=\"maxQuestions\" type=\"number\" min=\"1\" max=\"100\" value=\"" + escapeHtml(settings.maxQuestions) + "\"></label>",
    "<label>Passing score<input name=\"passingScore\" type=\"number\" min=\"50\" max=\"100\" value=\"" + escapeHtml(settings.passingScore) + "\"></label>",
    "<label class=\"check\"><input name=\"allowRetakes\" type=\"checkbox\" value=\"1\"" + (settings.allowRetakes ? " checked" : "") + "> Allow repeat attempts for this opening</label>",
    "</div>",
    "<label>Job description<textarea name=\"jd\" rows=\"10\" required>" + escapeHtml(job.jd || "") + "</textarea></label>",
    "<label>Market trends and interviewer guidance<textarea name=\"marketContext\" rows=\"4\">" + escapeHtml(job.marketContext || "") + "</textarea></label>",
    "<button class=\"button\" type=\"submit\">Save interview controls</button>",
    "</form>",
    "</section>",
    "<section class=\"section-gap\"><h2>Candidates</h2><div class=\"table-wrap\"><table>",
    "<thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>AI score</th><th>Recommendation</th><th>Summary</th><th>Good</th><th>Bad</th><th>Fit criteria</th><th>Submitted</th></tr></thead>",
    "<tbody>" + (rows || "<tr><td colspan=\"10\">No candidates yet.</td></tr>") + "</tbody>",
    "</table></div></section>"
  ].join("");
}

function errorView(message) {
  return "<section class=\"empty\"><h1>" + escapeHtml(message) + "</h1><a class=\"button\" href=\"/jobs\">Go to openings</a></section>";
}

function compactList(items) {
  return Array.isArray(items) ? items.filter(Boolean).slice(0, 3).join(" | ") : clean(items || "");
}

function compactFitCriteria(items) {
  if (!Array.isArray(items)) return "";
  return items.slice(0, 4).map(function(item) {
    return clean(item.criterion || "") + ": " + (item.met ? "met" : "not met") + (item.evidence ? " (" + clean(item.evidence) + ")" : "");
  }).join(" | ");
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
  const rows = await valuesGet(env, quoteSheet("Jobs") + "!A2:O");
  return rows.filter(function(row) {
    return row[0] && row[1];
  }).map(rowToJob).map(hydrateJob).sort(function(a, b) {
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
    estimatedMinutes: settingNumber(input.estimatedMinutes, MIN_INTERVIEW_MINUTES, MIN_INTERVIEW_MINUTES, 120),
    minQuestions: settingNumber(input.minQuestions, DEFAULT_MIN_QUESTIONS, 1, 80),
    maxQuestions: settingNumber(input.maxQuestions, DEFAULT_MAX_QUESTIONS, 1, 100),
    passingScore: settingNumber(input.passingScore, DEFAULT_PASSING_SCORE, 50, 100),
    allowRetakes: settingBool(input.allowRetakes),
    status: input.status || "active",
    sheetTitle: safeSheetTitle(input.title) + " " + id("").slice(-6),
    createdAt: new Date().toISOString(),
    jd: input.jd,
    marketContext: input.marketContext
  };
  if (job.maxQuestions < job.minQuestions) job.maxQuestions = job.minQuestions;
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
  const values = [JOBS_HEADER].concat(jobs.map(hydrateJob).map(jobToRow));
  await valuesUpdate(env, quoteSheet("Jobs") + "!A1:O", values);
  return job;
}

async function updateJobSettings(env, jobId, input) {
  const jobs = await readJobs(env);
  const job = jobs.find(function(item) {
    return item.id === jobId;
  });
  if (!job) return null;
  job.estimatedMinutes = input.estimatedMinutes;
  job.minQuestions = input.minQuestions;
  job.maxQuestions = Math.max(input.minQuestions, input.maxQuestions);
  job.passingScore = input.passingScore;
  job.allowRetakes = settingBool(input.allowRetakes);
  job.jd = input.jd;
  job.marketContext = input.marketContext;
  if (!hasGoogle(env)) {
    await writeFallbackJobs(env, jobs);
    return job;
  }
  const values = [JOBS_HEADER].concat(jobs.map(hydrateJob).map(jobToRow));
  await valuesUpdate(env, quoteSheet("Jobs") + "!A1:O", values);
  return job;
}

async function readApplications(env, job) {
  if (!hasGoogle(env)) {
    return readFallbackApplications(env, job.id);
  }
  await ensureApplicationSheet(env, job.sheetTitle);
  const rows = await valuesGet(env, quoteSheet(job.sheetTitle) + "!A2:Q");
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
        good: splitList(row[11]),
        bad: splitList(row[12]),
        fitCriteria: safeJson(row[13], []),
        followUpQuestions: splitList(row[14])
      },
      answers: safeJson(row[15], []),
      resumeText: row[16] || ""
    };
  }).sort(function(a, b) {
    return String(b.submittedAt).localeCompare(String(a.submittedAt));
  });
}

async function hasPriorApplication(env, job, candidate) {
  const normalizedEmail = normalizeEmail(candidate && candidate.email ? candidate.email : candidate);
  const normalizedPhone = normalizePhone(candidate && candidate.phone);
  if (!normalizedEmail && !normalizedPhone) return false;
  const applications = await readApplications(env, job);
  return applications.some(function(application) {
    const existing = application.candidate || {};
    return (normalizedEmail && normalizeEmail(existing.email) === normalizedEmail) || (normalizedPhone && normalizePhone(existing.phone) === normalizedPhone);
  });
}

function duplicateAttemptMessage(candidate) {
  const identifier = normalizeEmail(candidate && candidate.email ? candidate.email : candidate) || "this candidate";
  return "An interview has already been submitted for " + identifier + " on this opening. Contact the recruiter if a retake is needed.";
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
    if (stored && Array.isArray(stored) && stored.length) return stored.map(hydrateJob);
    const sample = memoryJobs();
    await env.AI_INTERVIEW_KV.put("jobs", JSON.stringify(sample));
    return sample;
  }
  return memoryJobs();
}

async function writeFallbackJobs(env, jobs) {
  const hydrated = jobs.map(hydrateJob);
  memory.jobs = hydrated;
  if (env.AI_INTERVIEW_KV) await env.AI_INTERVIEW_KV.put("jobs", JSON.stringify(hydrated));
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
    memory.jobs = [hydrateJob({
      id: "job_sample_ai_workflows",
      title: "Analyst - AI Workflows",
      department: "Operations",
      location: "Kolkata / On-site",
      positions: 5,
      estimatedMinutes: MIN_INTERVIEW_MINUTES,
      minQuestions: DEFAULT_MIN_QUESTIONS,
      maxQuestions: DEFAULT_MAX_QUESTIONS,
      passingScore: DEFAULT_PASSING_SCORE,
      allowRetakes: false,
      status: "active",
      sheetTitle: "Analyst AI Workflows",
      createdAt: new Date().toISOString(),
      jd: SAMPLE_JD,
      marketContext: "Focus on practical AI operations, model output review, prompt refinement, sales workflow QA, finance data validation, customer success automation, privacy, and documentation discipline."
    })];
  }
  return memory.jobs.map(hydrateJob);
}

function rowToJob(row) {
  return {
    id: row[0] || "",
    title: row[1] || "",
    department: row[2] || "",
    location: row[3] || "",
    positions: Number(row[4] || 1),
    estimatedMinutes: Math.max(MIN_INTERVIEW_MINUTES, Number(row[5] || MIN_INTERVIEW_MINUTES)),
    status: row[6] || "active",
    sheetTitle: row[7] || row[1] || "Job",
    createdAt: row[8] || "",
    jd: row[9] || "",
    marketContext: row[10] || "",
    minQuestions: Number(row[11] || DEFAULT_MIN_QUESTIONS),
    maxQuestions: Number(row[12] || DEFAULT_MAX_QUESTIONS),
    passingScore: Number(row[13] || DEFAULT_PASSING_SCORE),
    allowRetakes: settingBool(row[14])
  };
}

function jobToRow(job) {
  return [
    job.id,
    job.title,
    job.department,
    job.location,
    job.positions,
    interviewMinutes(job),
    job.status,
    job.sheetTitle,
    job.createdAt,
    job.jd,
    job.marketContext,
    interviewSettings(job).minQuestions,
    interviewSettings(job).maxQuestions,
    interviewSettings(job).passingScore,
    interviewSettings(job).allowRetakes ? "TRUE" : "FALSE"
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
    listCell(evaluation.good),
    listCell(evaluation.bad),
    JSON.stringify(evaluation.fitCriteria || []),
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

function hydrateJob(job) {
  const copy = Object.assign({}, job || {});
  const settings = interviewSettings(copy);
  copy.estimatedMinutes = settings.minMinutes;
  copy.minQuestions = settings.minQuestions;
  copy.maxQuestions = settings.maxQuestions;
  copy.passingScore = settings.passingScore;
  copy.allowRetakes = settings.allowRetakes;
  return copy;
}

function interviewSettings(job, state) {
  const allowRetakesSource = hasOwn(state, "allowRetakes") ? state.allowRetakes : job && job.allowRetakes;
  const minMinutes = settingNumber((state && state.minMinutes) || (job && job.estimatedMinutes), MIN_INTERVIEW_MINUTES, MIN_INTERVIEW_MINUTES, 120);
  const minQuestions = settingNumber((state && state.minQuestions) || (job && job.minQuestions), DEFAULT_MIN_QUESTIONS, 1, 80);
  const maxQuestions = settingNumber((state && state.maxQuestions) || (job && job.maxQuestions), DEFAULT_MAX_QUESTIONS, minQuestions, 100);
  const passingScore = settingNumber((state && state.passingScore) || (job && job.passingScore), DEFAULT_PASSING_SCORE, 50, 100);
  return {
    minMinutes: minMinutes,
    minQuestions: minQuestions,
    maxQuestions: Math.max(minQuestions, maxQuestions),
    targetQuestions: Math.max(minQuestions, maxQuestions),
    passingScore: passingScore,
    maybeScore: Math.max(60, passingScore - 15),
    strongHireScore: Math.min(95, passingScore + 7),
    allowRetakes: settingBool(allowRetakesSource)
  };
}

function interviewMinutes(job, state) {
  return interviewSettings(job, state).minMinutes;
}

function questionRangeText(settings) {
  return settings.minQuestions === settings.maxQuestions ? settings.minQuestions + " questions" : settings.minQuestions + "-" + settings.maxQuestions + " questions";
}

function settingNumber(value, fallback, min, max) {
  const parsed = Number(value);
  const number = Number.isFinite(parsed) ? Math.round(parsed) : fallback;
  return Math.max(min, Math.min(max, number));
}

function settingBool(value) {
  const normalized = clean(value).toLowerCase();
  return value === true || value === 1 || ["1", "true", "yes", "on", "allowed"].indexOf(normalized) !== -1;
}

function hasOwn(object, key) {
  return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
}

function elapsedInterviewMinutes(state) {
  return Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 60000);
}

function extraProbeQuestion(count) {
  const questions = [
    {
      question: "Take one answer you gave earlier and defend it under failure conditions: what exact evidence would prove you were wrong, and what would you change first?",
      competency: "Critical self-audit",
      expectedSignals: "Names falsifying evidence, measurable checks, priority order, and ownership of correction.",
      complexity: "stress",
      timeBoxMinutes: 2
    },
    {
      question: "You inherit an AI workflow that looks accurate in demos but fails in production. Give a step-by-step triage plan for the first two hours.",
      competency: "Production judgment",
      expectedSignals: "Logs, sampling, source comparison, rollback criteria, stakeholder communication, and root-cause isolation.",
      complexity: "advanced",
      timeBoxMinutes: 2
    },
    {
      question: "Describe the toughest tradeoff between speed and correctness in AI operations. Where would you refuse to automate?",
      competency: "Risk judgment",
      expectedSignals: "Concrete boundaries, compliance awareness, business impact, and escalation discipline.",
      complexity: "stress",
      timeBoxMinutes: 2
    },
    {
      question: "Design a pass/fail rubric for AI-generated sales outreach. Include disqualifying errors, not just quality positives.",
      competency: "Rubric design",
      expectedSignals: "Objective criteria, severe error classes, examples, thresholds, and repeatable scoring.",
      complexity: "advanced",
      timeBoxMinutes: 2
    }
  ];
  return questions[(count - 1) % questions.length];
}

async function generateInterview(env, job, resumeText) {
  const settings = interviewSettings(job);
  const prompt = [
    "Create a structured, high-bar screening interview for the candidate.",
    "Use the job description, resume, and market context together.",
    "The interview must be difficult, deeply probing, and designed to reveal weak fit quickly through job-related evidence.",
    "Mix resume-specific probes, JD-specific scenarios, compliance checks, data-quality cases, workflow judgment, failure analysis, quantified rubric design, and job-related disqualification traps based on real operational mistakes.",
    "Use differing complexities: baseline evidence checks, intermediate workflow diagnosis, advanced incident/rubric design, and stress questions that test judgment under pressure.",
    "Ask for concrete examples, metrics, edge cases, evidence, and tradeoffs. Avoid trivia, personal questions, or discriminatory questions.",
    "Return only JSON with this shape:",
    "{\"estimatedMinutes\":number,\"questions\":[{\"question\":\"string\",\"competency\":\"string\",\"complexity\":\"baseline|intermediate|advanced|stress\",\"expectedSignals\":\"string\",\"timeBoxMinutes\":number}]}",
    "Return " + settings.targetQuestions + " questions. Never return fewer than " + settings.minQuestions + " or more than " + settings.maxQuestions + ".",
    "Pace the questions for a minimum " + settings.minMinutes + " minute interview. Keep questions concise but demanding.",
    "The passing bar is " + settings.passingScore + "/100. The interview should make passing difficult unless the candidate gives specific, verifiable, operationally strong answers.",
    "JOB TITLE:\n" + job.title,
    "JD:\n" + normalizeText(job.jd, 10000),
    "MARKET CONTEXT:\n" + normalizeText(job.marketContext || env.DEFAULT_MARKET_CONTEXT || "", 4000),
    "RESUME:\n" + normalizeText(resumeText, 12000)
  ].join("\n\n");
  try {
    const result = await aiJson(env, [
      { role: "system", content: "You are an expert interviewer for AI workflow analyst roles. Return only valid JSON." },
      { role: "user", content: prompt }
    ], 0.35);
    if (!result.questions || !Array.isArray(result.questions) || result.questions.length < 1) throw new Error("No questions returned");
    const questions = normalizeInterviewQuestions(result.questions, settings, job);
    return {
      estimatedMinutes: Math.max(settings.minMinutes, Number(result.estimatedMinutes || settings.minMinutes)),
      questions: questions
    };
  } catch (error) {
    const fallback = fallbackInterview(job);
    fallback.note = "Using fallback questions because AI generation is unavailable: " + error.message;
    return fallback;
  }
}

async function evaluateInterview(env, job, state) {
  const settings = interviewSettings(job, state);
  const prompt = [
    "Evaluate this candidate for the role.",
    "Score only from the resume and answers. Be strict, fair, evidence-based, and selective.",
    "Default to disqualifying weak, generic, evasive, or unverifiable answers. Reward specific operational evidence, measurable QA discipline, privacy judgment, and ability to translate failures into engineering feedback.",
    "Hire/Strong Hire is a pass. Maybe/No Hire is not a pass.",
    "Return only JSON with this shape:",
    "{\"score\":number,\"recommendation\":\"Strong Hire|Hire|Maybe|No Hire\",\"summary\":\"string\",\"good\":[\"string\"],\"bad\":[\"string\"],\"fitCriteria\":[{\"criterion\":\"string\",\"met\":boolean,\"evidence\":\"string\"}],\"strengths\":[\"string\"],\"risks\":[\"string\"],\"followUpQuestions\":[\"string\"],\"rubric\":[{\"area\":\"string\",\"score\":number,\"comment\":\"string\"}]}",
    "Score out of 100 using this hard bar: " + settings.strongHireScore + "+ Strong Hire, " + settings.passingScore + "-" + (settings.strongHireScore - 1) + " Hire, " + settings.maybeScore + "-" + (settings.passingScore - 1) + " Maybe, below " + settings.maybeScore + " No Hire. Be comfortable giving No Hire.",
    "A passing candidate must meet these criteria: demonstrated AI output audit/rubric skill, role-relevant workflow evidence, privacy/compliance judgment, ability to document failures for engineering, and concrete metrics or examples. Missing evidence on any major criterion should prevent Hire.",
    "JOB:\n" + job.title,
    "JD:\n" + normalizeText(job.jd, 9000),
    "MARKET CONTEXT:\n" + normalizeText(job.marketContext || env.DEFAULT_MARKET_CONTEXT || "", 3000),
    "RESUME:\n" + normalizeText(state.resumeText, 10000),
    "Q AND A:\n" + JSON.stringify(state.answers)
  ].join("\n\n");
  try {
    const result = await aiJson(env, [
      { role: "system", content: "You are a strict but fair AI interview evaluator. Return only valid JSON." },
      { role: "user", content: prompt }
    ], 0.2);
    const score = settingNumber(result.score, 0, 0, 100);
    return {
      score: score,
      recommendation: recommendationFromScore(score, settings),
      summary: clean(result.summary || ""),
      good: Array.isArray(result.good) ? result.good.map(clean) : [],
      bad: Array.isArray(result.bad) ? result.bad.map(clean) : [],
      fitCriteria: Array.isArray(result.fitCriteria) ? result.fitCriteria : [],
      strengths: Array.isArray(result.strengths) ? result.strengths.map(clean) : [],
      risks: Array.isArray(result.risks) ? result.risks.map(clean) : [],
      followUpQuestions: Array.isArray(result.followUpQuestions) ? result.followUpQuestions.map(clean) : [],
      rubric: Array.isArray(result.rubric) ? result.rubric : []
    };
  } catch (_) {
    return fallbackEvaluation(job, state);
  }
}

function recommendationFromScore(score, settings) {
  if (score >= settings.strongHireScore) return "Strong Hire";
  if (score >= settings.passingScore) return "Hire";
  if (score >= settings.maybeScore) return "Maybe";
  return "No Hire";
}

async function aiJson(env, messages, temperature) {
  if (env.OPENAI_API_KEY) return openAiJson(env, messages, temperature);
  return openRouterJson(env, messages, temperature);
}

async function openAiJson(env, messages, temperature) {
  const model = env.OPENAI_MODEL || "gpt-4o-mini";
  const requestBody = {
    model: model,
    messages: messages,
    response_format: { type: "json_object" }
  };
  if (supportsCustomTemperature(model)) requestBody.temperature = temperature;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.OPENAI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });
  if (!response.ok) throw new Error("OpenAI " + response.status + ": " + (await response.text()).slice(0, 220));
  const data = await response.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return parseJsonObject(content || "");
}

function supportsCustomTemperature(model) {
  return !/^gpt-[56]/.test(String(model || ""));
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

function normalizeInterviewQuestions(rawQuestions, settings, job) {
  const cleaned = rawQuestions.map(function(q) {
    return {
      question: clean(q.question),
      competency: clean(q.competency || "Interview signal"),
      complexity: normalizeComplexity(q.complexity),
      expectedSignals: clean(q.expectedSignals || ""),
      timeBoxMinutes: Number(q.timeBoxMinutes || 1)
    };
  }).filter(function(q) {
    return q.question.length > 12;
  });
  const fallback = fallbackQuestions(job, settings.targetQuestions);
  let cursor = 0;
  while (cleaned.length < settings.minQuestions && cursor < fallback.length) {
    cleaned.push(fallback[cursor]);
    cursor += 1;
  }
  while (cleaned.length < settings.targetQuestions && cursor < fallback.length) {
    cleaned.push(fallback[cursor]);
    cursor += 1;
  }
  return paceQuestions(cleaned.slice(0, settings.maxQuestions), settings);
}

function paceQuestions(questions, settings) {
  const pattern = ["baseline", "intermediate", "advanced", "stress", "intermediate", "advanced", "stress"];
  const paced = questions.map(function(q, index) {
    const complexity = normalizeComplexity(q.complexity || pattern[index % pattern.length]);
    return Object.assign({}, q, {
      complexity: complexity,
      timeBoxMinutes: 1
    });
  });
  let remaining = Math.max(0, settings.minMinutes - paced.length);
  const priority = paced.map(function(q, index) {
    const weight = q.complexity === "stress" ? 4 : q.complexity === "advanced" ? 3 : q.complexity === "intermediate" ? 2 : 1;
    return { index: index, weight: weight };
  }).sort(function(a, b) {
    return b.weight - a.weight || b.index - a.index;
  });
  const maxPerQuestion = Math.max(2, Math.min(6, Math.ceil(settings.minMinutes / Math.max(1, paced.length)) + 1));
  let cursor = 0;
  while (remaining > 0 && paced.length) {
    const item = priority[cursor % priority.length];
    if (paced[item.index].timeBoxMinutes < maxPerQuestion) {
      paced[item.index].timeBoxMinutes += 1;
      remaining -= 1;
    }
    cursor += 1;
    if (cursor > priority.length * maxPerQuestion * 2) break;
  }
  return paced;
}

function normalizeComplexity(value) {
  const normalized = clean(value || "").toLowerCase();
  return ["baseline", "intermediate", "advanced", "stress"].indexOf(normalized) === -1 ? "intermediate" : normalized;
}

function fallbackInterview(job) {
  const settings = interviewSettings(job);
  return {
    estimatedMinutes: settings.minMinutes,
    questions: paceQuestions(fallbackQuestions(job, settings.targetQuestions), settings)
  };
}

function fallbackQuestions(job, count) {
  const pool = fallbackQuestionPool(job);
  const questions = [];
  for (let index = 0; index < count; index += 1) {
    const base = pool[index % pool.length];
    questions.push(Object.assign({}, base, {
      question: base.question + (index >= pool.length ? " Use a different example from any earlier answer." : "")
    }));
  }
  return questions;
}

function fallbackQuestionPool(job) {
  const title = (job && job.title) || "this role";
  return [
    { question: "Walk me through the strongest evidence that your past work maps to " + title + ". Avoid generalities; give tools, volume, error rates, and outcomes.", competency: "Resume evidence", complexity: "baseline", expectedSignals: "Specific metrics, named workflows, honest scope, measurable outcomes." },
    { question: "Which part of the JD is closest to work you have actually done, and which part is weakest for you? Give evidence for both.", competency: "Role fit honesty", complexity: "baseline", expectedSignals: "Self-awareness, concrete examples, and no inflated claims." },
    { question: "Explain how you would audit one AI-generated answer for factual accuracy, contextual relevance, tone, and business risk.", competency: "AI output evaluation", complexity: "baseline", expectedSignals: "Source checks, rubric criteria, severity labels, and repeatability." },
    { question: "Design a scoring rubric for AI-generated customer support responses. What errors are automatic failures?", competency: "Rubric design", complexity: "intermediate", expectedSignals: "Objective criteria, severe error classes, source checks, escalation rules." },
    { question: "A CRM enrichment workflow is silently adding wrong company data. How do you detect it, contain it, and prove the fix worked?", competency: "Data quality incident response", complexity: "advanced", expectedSignals: "Sampling, source comparison, rollback, audit logs, measurable validation." },
    { question: "Give a finance extraction example where automation should not be trusted. What controls would you put before reporting?", competency: "Financial validation", complexity: "advanced", expectedSignals: "Reconciliation, source evidence, approval thresholds, exception handling." },
    { question: "Show how you would improve a weak prompt for lead scoring or outreach drafting. What test set would prove improvement?", competency: "Prompt testing", complexity: "intermediate", expectedSignals: "Before/after thinking, test cases, false positives, performance metrics." },
    { question: "A model gives a confident but false summary of a client onboarding call. How would you document the issue for engineering?", competency: "Failure documentation", complexity: "intermediate", expectedSignals: "Inputs, expected vs actual, reproduction, frequency, severity, business impact." },
    { question: "What data should never be sent into an AI workflow without controls, and what controls are non-negotiable?", competency: "Privacy and governance", complexity: "baseline", expectedSignals: "PII handling, masking, retention, consent, least privilege, access control." },
    { question: "You have 500 AI outputs to rank by quality today. Explain your sampling, labeling, and calibration process.", competency: "High-volume execution", complexity: "advanced", expectedSignals: "Batching, inter-rater checks, examples, fatigue controls, consistency." },
    { question: "Tell me about a time you found a systematic process error. What did you do after identifying it?", competency: "Operational ownership", complexity: "baseline", expectedSignals: "Root cause, stakeholder communication, durable fix, measured improvement." },
    { question: "Where would you draw the line between analyst responsibility and engineering responsibility in an AI workflow failure?", competency: "Bridge operations and tech", complexity: "intermediate", expectedSignals: "Clear handoff, evidence quality, prioritization, collaboration boundaries." },
    { question: "If your manager asks you to approve outputs you have not validated because the offer deadline is today, what do you do?", competency: "Integrity under pressure", complexity: "stress", expectedSignals: "Risk framing, escalation, partial approval boundaries, refusal when needed." },
    { question: "Take one AI workflow from the JD and define five measurable quality benchmarks for it.", competency: "Quality benchmark design", complexity: "intermediate", expectedSignals: "Measurable metrics, thresholds, sample design, and operational ROI." },
    { question: "A sales leader complains that AI outreach drafts sound polished but do not convert. What evidence do you collect before changing the workflow?", competency: "Sales workflow diagnosis", complexity: "advanced", expectedSignals: "Conversion data, segmentation, message quality, CRM fields, and test design." },
    { question: "How would you identify hallucinations that are rare but high impact in a post-sales automation pipeline?", competency: "Rare-risk detection", complexity: "advanced", expectedSignals: "Targeted sampling, severe-case taxonomy, escalation, and trend reporting." },
    { question: "Give a bad example of a prompt instruction for financial categorization, then rewrite it into a testable instruction.", competency: "Prompt framework refinement", complexity: "intermediate", expectedSignals: "Concrete rewrite, edge cases, source hierarchy, and validation criteria." },
    { question: "The model output passes your checklist but a client says it is wrong. How do you investigate without becoming defensive?", competency: "Client-facing judgment", complexity: "stress", expectedSignals: "Evidence review, humility, communication, correction path, and prevention." },
    { question: "Which spreadsheet checks would you run before trusting an AI-generated financial report?", competency: "Spreadsheet and finance QA", complexity: "intermediate", expectedSignals: "Totals, reconciliations, outliers, missing values, duplicates, and audit trail." },
    { question: "Explain how you would categorize AI failures so engineering can prioritize fixes instead of reading anecdotes.", competency: "Issue taxonomy", complexity: "advanced", expectedSignals: "Severity, frequency, reproducibility, impact, owners, and examples." },
    { question: "A candidate answer looks fluent but contains no evidence. How should the evaluator score it, and why?", competency: "Evaluation discipline", complexity: "baseline", expectedSignals: "Evidence standard, scoring consistency, and resistance to style bias." },
    { question: "What is your process for calibrating multiple reviewers so quality scores are consistent across a campaign?", competency: "Reviewer calibration", complexity: "advanced", expectedSignals: "Gold set, disagreements, examples, thresholds, and periodic recalibration." },
    { question: "You discover that an AI workflow improves speed but increases compliance risk. What recommendation do you make?", competency: "Risk tradeoff", complexity: "stress", expectedSignals: "Stop/go criteria, mitigation, stakeholder framing, and governance." },
    { question: "Name three edge cases for automated lead scoring and how each should be represented in a test set.", competency: "Edge-case coverage", complexity: "intermediate", expectedSignals: "Concrete edge cases, expected outcomes, and regression testing." },
    { question: "Describe a one-day plan to audit this JD's sales, support, and finance AI workflows from zero context.", competency: "Execution planning", complexity: "advanced", expectedSignals: "Prioritization, data access, sampling, stakeholders, and first deliverables." },
    { question: "If the model and source system disagree, what is your source-of-truth policy?", competency: "Source discipline", complexity: "baseline", expectedSignals: "Primary records, auditability, escalation, and documentation." },
    { question: "What would make you disqualify an AI-generated customer success log even if it is grammatically perfect?", competency: "Disqualifying defects", complexity: "intermediate", expectedSignals: "Wrong facts, missing obligations, privacy leaks, unsupported claims, tone risk." },
    { question: "How would you measure whether prompt changes improved operational ROI rather than only making outputs sound better?", competency: "ROI measurement", complexity: "advanced", expectedSignals: "Baseline, controlled test, speed, accuracy, rework, conversion, support load." },
    { question: "You have ten minutes before a same-day offer decision. What are the highest-signal checks you run on this candidate's answers?", competency: "Screening judgment", complexity: "stress", expectedSignals: "Evidence density, contradiction checks, role-critical criteria, and risk flags." },
    { question: "Give your first-week plan for this role, including what you would audit, what metrics you would define, and what would disqualify a workflow from automation.", competency: "Readiness and judgment", complexity: "advanced", expectedSignals: "Structured plan, quality benchmarks, workflow triage, practical priorities." }
  ];
}

function fallbackEvaluation(job, state) {
  const settings = interviewSettings(job, state);
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
    recommendation: recommendationFromScore(score, settings) === "No Hire" ? "No Hire" : "Maybe",
    summary: "Fallback score for " + job.title + ". AI evaluation was unavailable, so use this only as a screening aid.",
    good: keywordHitsDescription(hits),
    bad: ["AI scoring model was unavailable; a human reviewer must validate the answer quality before advancing."],
    fitCriteria: [
      { criterion: "Role-specific AI workflow evidence", met: hits >= 4, evidence: "Keyword and answer-completion based fallback estimate." },
      { criterion: "Detailed answer depth", met: answered >= settings.minQuestions, evidence: answered + " substantive answers captured." },
      { criterion: "Ready for same-day offer", met: false, evidence: "Fallback scoring cannot authorize an offer." }
    ],
    strengths: ["Candidate completed the AI interview."],
    risks: ["AI scoring model was unavailable; human review is required."],
    followUpQuestions: ["Validate the candidate's answers in the human round."],
    rubric: []
  };
}

function keywordHitsDescription(hits) {
  if (hits >= 6) return ["Candidate referenced several relevant AI workflow concepts."];
  if (hits >= 3) return ["Candidate referenced some relevant AI workflow concepts, but depth is unverified."];
  return ["Candidate completed the interview, but fallback scoring found limited role-specific signal."];
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

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function normalizePhone(value) {
  return clean(value).replace(/\D/g, "");
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
    ".page-head{margin-bottom:22px}.page-head h1,.split h1,.interview h1,.complete h1,.auth h1,.preflight h1{margin:0 0 10px;font-size:clamp(28px,5vw,48px);line-height:1.03}",
    ".page-head p,.complete p,.muted,.hint,.lead{color:var(--muted)}.lead{max-width:720px;font-size:18px;line-height:1.5}.hint{font-size:13px;line-height:1.4}.hint.bad{color:var(--warn)}",
    ".row{display:flex;align-items:center;justify-content:space-between;gap:20px}.stack{display:grid;gap:14px}",
    ".job-card,.panel,.auth,.interview,.complete,.wide{background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 24px rgba(17,24,39,.05)}",
    ".job-card{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:22px}.job-card h2{margin:4px 0 6px;font-size:22px}",
    ".eyebrow{margin:0 0 8px;color:var(--accent);font-size:12px;font-weight:800;letter-spacing:0;text-transform:uppercase}",
    ".button{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 16px;border:1px solid var(--brand);border-radius:6px;background:var(--brand);color:white;font-weight:800;text-decoration:none;cursor:pointer}",
    ".button:hover{background:var(--brand-dark)}.button.secondary{background:white;color:var(--brand)}.button.full{width:100%}.button:disabled{opacity:.65;cursor:wait}",
    ".split{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:28px;align-items:start}.preflight-grid{display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:22px;align-items:start}.panel,.auth,.interview,.complete,.wide{padding:24px}.auth{width:min(420px,100%);margin:8vh auto 0}",
    ".form{display:grid;gap:16px}.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}",
    "label{display:grid;gap:7px;color:#344054;font-size:14px;font-weight:700}",
    "input,textarea,select{width:100%;min-height:42px;padding:10px 12px;border:1px solid #cbd5e1;border-radius:6px;background:white;color:var(--ink);font:inherit}input[type=checkbox]{width:auto;min-height:auto;padding:0}textarea{resize:vertical}",
    "label.check{display:flex;align-items:center;gap:10px;min-height:42px}",
    "input:focus,textarea:focus,select:focus{outline:3px solid rgba(15,118,110,.18);border-color:var(--brand)}",
    ".jd{margin-top:18px;color:#344054;line-height:1.6}.jd.compact{max-height:300px;overflow:auto}",
    ".flash{margin:0 0 18px;padding:12px 14px;border:1px solid #fedf89;border-radius:6px;background:#fffaeb;color:#93370d}",
    ".progress{height:8px;border-radius:999px;overflow:hidden;background:#e6ebf2;margin-bottom:24px}.progress span{display:block;height:100%;background:var(--brand)}",
    ".clean-list{margin:0;padding-left:18px;color:#344054;line-height:1.65}.checks{display:grid;gap:10px;margin:14px 0}.check-row{margin:0;padding:12px;border:1px solid var(--line);border-radius:6px;background:#f8fafc;color:#475467}.check-row.ok{border-color:#9dd4c9;background:#eefaf7;color:#115e59}.check-row.bad{border-color:#f6c7a7;background:#fff4ed;color:#93370d}.next-card{margin:20px 0;padding:16px;border:1px solid var(--line);border-radius:8px;background:#f8fafc;text-align:left}.next-card p{margin:6px 0 0}",
    ".table-wrap{overflow-x:auto;background:white;border:1px solid var(--line);border-radius:8px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:13px 14px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{background:#f8fafc;color:#475467;font-size:12px;text-transform:uppercase;letter-spacing:0}tr:last-child td{border-bottom:0}",
    ".status-form{display:flex;gap:10px;align-items:center}.empty{padding:46px 0;text-align:center}.complete{max-width:680px;margin:8vh auto 0;text-align:center}.section-gap{margin-top:24px}.pill{display:inline-flex;padding:3px 8px;border-radius:999px;background:#eef6f5;color:#115e59;font-weight:800;font-size:12px}",
    "@media(max-width:760px){.topbar,.row,.job-card,.status-form{align-items:stretch;flex-direction:column}nav{width:100%;justify-content:space-between}.split,.grid-2,.preflight-grid{grid-template-columns:1fr}.page-head h1,.split h1,.interview h1,.complete h1,.auth h1,.preflight h1{font-size:32px}}"
  ].join("");
}
