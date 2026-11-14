Cloudflare architecture: high-level write-up

1. The shape

One private web app, built only from Cloudflare free-tier services.
It is a single modular app, not microservices (many tiny separate services).
Your phone, tablet and desktop all use the same live data through a browser.

2. Components

Cloudflare Access: the login wall in front of everything. Nothing loads until you sign in, including question files.
Worker static assets: host the app’s screens (HTML, CSS and JavaScript files).
One Worker, the API (the app’s back office): reads and writes data, runs imports, saves attempts and grades, and updates metrics.
D1 (Cloudflare’s SQLite database) holds:
questions, versions and metadata;
concepts, weights and prerequisites;
custom fields;
saved filters and papers;
attempts and grades;
live metrics.
R2 (file storage) holds:
the original uploaded HTML files, unchanged;
each split-out question file;
images, fonts and styles.
Files are named by their content fingerprint (hash), so each file is stored once, never duplicated.

3. Three kinds of data, kept apart

Content: question files in R2. They are never edited; a change becomes a new version.
Metadata: tags, weights, answer keys and solutions in D1. They are editable, and every change is logged.
History: attempts and grades in D1. They are add-only and never edited or deleted.
Metrics: a derived copy, updated live with each grade and rebuildable from history at any time.

4. Key flows

Import
Upload one HTML file.
The Worker saves the original to R2.
It splits the file on the question numbers.
It gives each question a permanent ID and records its source (file + question number).
It shows the review screen.
On “Accept”, it saves everything in one all-or-nothing step.
Filter: the phone loads all question metadata once, roughly 1,000 small rows. Filtering then runs on the device, so it feels instant.
Paper: the sampler runs on the device and picks questions. The Worker saves the paper as a frozen list.
Practice:
The question shows in a sandboxed iframe (a locked box inside the page) with no scripts and no outside internet calls.
You answer and grade it.
The Worker saves the attempt, the grade and the metric updates in one step.
Analytics: the Worker reads the live metrics from D1, and the charts are drawn on the device.

5. Security
Access is the main gate; you are the only allowed user.


6. Free-tier fit (at today’s usage)

D1: about 5 million reads and 100,000 writes per day are allowed. You will use under 1%.
Workers: about 100,000 requests per day are allowed. You will use a few hundred.
CPU: each request may use 10 ms of processor time. Heavy maths (filtering, sampling, trends) therefore runs on your device, not the Worker.
Sleep: it never goes to sleep. If a daily limit is ever hit, the app shows a friendly message until the reset at midnight UTC.

7. Safety net

Weekly export: one archive containing the D1 dump, all R2 files and a list of checksums (codes that prove nothing is missing or changed). Keep it off Cloudflare.
Time Travel: D1 can rewind up to 7 days.
Restore: reload the archive, check the checksums, and rebuild the metrics.

8. Build and deploy

Keep the code in a public GitHub repository, built with Claude Code.
Use Wrangler (Cloudflare’s command-line tool) to test on your computer and to deploy.
Every database change is a numbered migration (a scripted change), run only after an automatic backup.