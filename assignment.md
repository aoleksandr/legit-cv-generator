# Fullstack Engineer — Test Task: AI CV Builder

## Goal

Build a small AI CV Builder with a real backend. A signed-in user uploads a CV as a PDF or describes their background in free text, names a target role, and gets a CV they can review, edit and download as a PDF. How you structure the system is up to you: your design decisions are part of what we evaluate.

**Time limit:** up to 10 hours. AI coding tools are allowed.

## What the product must do

- Users sign up and log in with email and password. A user can only see and change their own CVs.
- The user provides a PDF or free text plus a target role (for example, "Senior Backend Engineer"). The app generates a CV draft: contact details, summary, experience, education and skills. Descriptions become concise bullet points, the summary targets the role, and the most relevant experience comes first.
- Generation can take a while. The user should not be stuck on a frozen screen, and reloading the page must not lose the work in progress.
- The AI may rephrase and restructure, but must not invent facts. Anything missing or vague becomes a question to the user, and the answer updates the relevant part of the CV.
- The user can edit any field by hand and download the result as an A4 PDF with selectable text.
- The user can come back later, from any device, and find their CVs.
- The app is usable on a phone.

## Constraints

- Node.js on the backend, REST API.
- Anthropic API (Claude models) for all LLM calls.
- PostgreSQL or SQLite.
- No deployment: the project runs locally with `docker compose up`. The only secret is `ANTHROPIC_API_KEY`; we will use our own key.

**Out of scope:** multiple templates, tailoring to a job description, OAuth, password reset, email verification, payments, admin panel.

If you run out of time, cut features rather than reliability, and say what you cut in the README.

## Deliverables

A GitHub repository with a readable commit history, tests for the parts you consider most important, and a short README that explains:

- how to run the project and the tests;
- your architecture and the main decisions behind it;
- how you keep the AI from inventing facts;
- what you simplified and what you would do differently with more time;
- how you used AI tools.

## What we evaluate

- Whether the whole flow works;
- how you designed the system;
- how you handle failures and untrusted input, including LLM output;
- the quality of your trade-offs within 10 hours;
- and whether you can review and own AI-generated code rather than just produce it.
