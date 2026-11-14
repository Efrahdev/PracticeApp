# Practice App — Functional Requirements

Nov 13, 2026 · @Arhaan

## Scope and assumptions

One private app that lets one learner store up to 1,000 questions, filter them, build practice papers, solve and grade them, and see progress over time — on phone, tablet and desktop, at zero infrastructure cost on Cloudflare's free tier.

- **User:** exactly one person. No sign-up, no roles, no sharing.
- **Volume:** about 1,000 questions and 20–25 solved per day today. These are indicative, not limits; the design must handle growth or shrinkage without changes.
- **Question format:** questions arrive in HTML files that each hold many questions (often 50–100), with their images, fonts and styles.
- **Priority labels:** **Must** = needed for first release; **Should** = soon after; **Could** = nice to have.
- **How to validate:** for each row, mark it Keep, Change or Drop, and comment on anything unclear.

## 1. Question library and import

The original question file is never changed; everything you add about it lives beside it.

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-1.1 | Upload one HTML file at a time; the file may contain many questions (50, 100 or more). | Must |
| FR-1.2 | Split the file into individual questions automatically, each keeping its own images, styles and layout exactly as authored. | Must |
| FR-1.3 | Before saving, show a review screen: number of questions found, a preview of each, missing images/fonts, and questions already in the library. Accept, edit or reject per question or for the whole file. | Must |
| FR-1.4 | Keep the uploaded file unchanged. Each question remembers which file and position it came from. A changed question becomes a new version; old attempts stay linked to the version used. | Must |
| FR-1.5 | Show each question exactly as authored, isolated from the app's own styles, with no scripts running and no outside internet calls. | Must |
| FR-1.6 | Edit metadata: subject, concepts (several, each with a weight), difficulty label, answer key, solution, notes. | Must |
| FR-1.7 | Add metadata for many questions at once (e.g. tag all questions from one file with a subject), or via a spreadsheet. | Should |
| FR-1.8 | Add new custom fields (text, number, date, yes/no) from the app, without code changes, and choose which ones can be filtered. | Should |
| FR-1.9 | Keep a concept tree (e.g. Maths → Algebra → Quadratics) and prerequisite links between concepts. | Should |
| FR-1.10 | Accept AI-suggested tags, answer keys and solutions only as proposals marked Unverified until you approve or correct them. | Should |
| FR-1.11 | Search questions by text, ID or tag. | Should |

## 2. Filtering and saved filters

Any combination of filters should return results instantly (under half a second for 1,000 questions).

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-2.1 | Filter by subject, concept (optionally including sub-concepts and a minimum weight), and difficulty label. | Must |
| FR-2.2 | Filter by history: never attempted, attempt count, last result (correct/incorrect/partial), last attempted more than N days ago. | Must |
| FR-2.3 | Filter by personal difficulty (how hard it has been for you) separately from the authored label. | Should |
| FR-2.4 | Filter by date added, time taken, and any filterable custom field. | Should |
| FR-2.5 | Combine filters with AND / OR. | Must |
| FR-2.6 | Save a filter with a name; dates are stored as relative rules ("last 30 days") so they stay current. | Must |
| FR-2.7 | Show a results list with key facts only (no full question rendering) and a count of matches. | Must |

## 3. Paper builder

A paper = a filter + sampling settings + a seed (a starting number that makes random picks repeatable), frozen into a fixed list.

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-3.1 | Build a paper of any length from a filter; never repeat a question within one paper. | Must |
| FR-3.2 | If the filter has fewer questions than requested, say so and let you change the filter or length. | Must |
| FR-3.3 | Set a mix: share by subject, concept and difficulty (e.g. 40% algebra, 60% geometry; mostly medium). | Should |
| FR-3.4 | Favour questions you got wrong, have not seen recently, or have weak concepts; avoid ones whose prerequisites you have not mastered. | Should |
| FR-3.5 | Same filter + settings + seed always gives the same paper. | Should |
| FR-3.6 | Show why each question was picked (which target it fills, its score). | Could |
| FR-3.7 | Save the paper unchanged forever; regenerating creates a new paper. | Must |
| FR-3.8 | Reorder, swap or remove questions before starting. | Could |

## 4. Practice, attempts and grading

History is never overwritten: every attempt and every grade is a new record; a correction adds a new grade on top.

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-4.1 | Solve a paper or single question one at a time; pause and resume later. No countdowns, time limits or timed exams anywhere; time spent is recorded quietly for information only. | Must |
| FR-4.2 | Record each attempt: question version, date/time, time taken, your answer (option chosen or text typed), paper it belongs to. | Must |
| FR-4.3 | Grade manually: correct, incorrect or partial. Always available, the default. | Must |
| FR-4.4 | Auto-grade only questions with a verified answer key (multiple choice, or numeric with tolerance). | Should |
| FR-4.5 | Add error type (e.g. silly mistake, concept gap), confidence and a note to a grade. | Should |
| FR-4.6 | Correct a past grade without deleting the old one. | Must |
| FR-4.7 | Show the solution after grading. | Must |
| FR-4.8 | Re-grade old attempts automatically when an answer key is added later. | Could |
| FR-4.9 | Paper summary at the end: score, time, mistakes by concept. | Should |

## 5. Analytics

Every metric updates live, in the same save as each grade, so the next filter or paper already uses it. All metrics can also be rebuilt from history and must come out identical; changing tags updates them, but saved papers stay as they were.

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-5.1 | Per question: attempt count, last result, last date, average and last time taken. | Must |
| FR-5.2 | Per concept and subject: accuracy and trend over time (weighted by concept weight). | Must |
| FR-5.3 | Personal difficulty per question: starts from the authored label, adjusts with your results. | Should |
| FR-5.4 | Familiarity per question: rises with exposure, fades with time since last seen. | Should |
| FR-5.5 | Weakest concepts list, with a one-tap "build a paper on these". | Should |
| FR-5.6 | Daily activity view: questions solved per day and streak. | Could |

## 6. Access, devices and backup

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-6.1 | Only you can open the app: a login wall in front of everything, including question files. | Must |
| FR-6.2 | Works on phone, tablet and desktop browsers; the same data on every device. | Must |
| FR-6.3 | Export everything in one archive (questions, assets, metadata, filters, papers, attempts, grades) with a checksum list. | Must |
| FR-6.4 | Also export attempts and questions as CSV/JSON you can open in a spreadsheet. | Should |
| FR-6.5 | Restore from an archive, check it is complete, and rebuild all analytics. | Must |
| FR-6.6 | Show a friendly message (not a crash) if a free-tier daily limit is ever reached. | Should |

## 7. Data rules (schema integrity)

These rules make the data impossible to corrupt silently: nothing is lost, nothing is counted twice, and every number can be traced back to the events that produced it.

| ID | Rule | Priority |
| --- | --- | --- |
| DR-1 | Every question gets a permanent ID at import, never reused, and independent of file name or position in the file. | Must |
| DR-2 | Each question's content gets a fingerprint (hash). Re-uploading the same question is recognised, never duplicated; changed content becomes a new version of the same question. | Must |
| DR-3 | Three kinds of data are kept apart: **content** (never edited), **metadata** (editable; every change logged with old value and time), **history** (attempts and grades; add-only, never edited or deleted). | Must |
| DR-4 | Every save is all-or-nothing: an import of 100 questions, or a grade plus its metric updates, either fully lands or not at all. | Must |
| DR-5 | The database itself enforces links and valid values: no grade without an attempt, no attempt without a question version, concept weights between 0 and 1, results only from the allowed list. | Must |
| DR-6 | Live metrics are a copy derived from history. A rebuild from history must give identical numbers; any mismatch is reported. | Must |
| DR-7 | Nothing is hard-deleted: questions, concepts and fields are archived, so history always stays complete. | Must |
| DR-8 | Everything is referenced by ID, not name: renaming or merging a concept never breaks past data. | Must |
| DR-9 | Each grade records which answer-key version and scoring rule produced it. | Must |
| DR-10 | Times are stored in UTC and shown in local time; durations in seconds. | Must |
| DR-11 | The schema has a version number. Every change is a written, tested migration, run only after an automatic backup. | Must |
| DR-12 | A built-in integrity check can be run at any time: missing assets, broken links, duplicate content, metric mismatches. | Should |

## Out of scope

- Multiple users, sharing, or public pages
- Writing new questions inside the app
- Offline use with no internet
- Any paid service

## Open questions to settle

- [ ] Answered: each question in a file carries a question number. The app splits on it, then assigns a permanent ID (DR-1) and stores file + question number as the source. Still needed: one sample file to confirm the exact HTML markup.
- [ ] Do any question files contain scripts that must run (e.g. interactive diagrams)? If yes, FR-1.5 needs an exception.
- [ ] Which answer types exist: only multiple choice and numeric, or also text and worked solutions?
- [x] Is partial credit needed, or only correct/incorrect?
- [x] Do you want a daily reminder or target (e.g. 25 a day)?
- [x] Should a paper be timed as a whole (exam mode) as well as per question?
