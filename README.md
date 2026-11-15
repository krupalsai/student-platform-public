# Student Platform

A live student-services platform for court-case tracking, fee payments, and support — used by 150+ students across two colleges.

**Live site:** https://studentplatform.dev

Built and operated by [Sai Krupal Kusanapelli](https://github.com/krupalsai).

## What it does

Students involved in a college writ petition need three things: to know where their case stands, to pay their batch fee, and to get answers fast. Student Platform puts all three in one installable web app (PWA) — no separate apps to install, no links to hunt for.

- **Case tracking** — students follow their petition's progress, get hearing alerts, and see a live indicator the moment their case is called in court, plus case news and a route map of the process.
- **Fee payments** — batch fees paid online via Cashfree with webhook verification, payment status tracking, and receipts. Admins see exactly which payments were really received.
- **Support** — a WhatsApp support bot answers common questions from the platform's own FAQ using a LangChain + LangGraph RAG chain, with in-app support conversations and escalation to staff when it doesn't know.
- **Registration** — students register with a college ID photo (with a signature check), join a batch through a registration link, and complete their profile.
- **Admin console** — batches, students, payments, announcements, push notifications, reporting, and data exports.
- **Notifications** — in-app inbox, web push (VAPID), and WhatsApp updates.

## Tech stack

| Layer | Technology |
| --- | --- |
| Framework | Next.js 15 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS |
| Database | PostgreSQL via Supabase (migrations in `supabase/migrations/`) |
| Hosting | Vercel |
| File storage | Cloudinary |
| Payments | Cashfree (webhook-verified) |
| AI support bot | LangChain + LangGraph RAG over the platform FAQ, with Gemini / Groq / OpenRouter fallback |
| Messaging | WhatsApp Cloud API, Web Push (VAPID) |
| Mobile | Capacitor Android wrapper (`android/`), PWA as the primary student experience |

## Getting started

### Prerequisites

- Node.js 20+ (22 recommended) and npm
- A Supabase project (PostgreSQL)
- Accounts/keys only for the integrations you want to use — the app runs without optional ones, and the routes that need them stay off until configured

### 1. Get the code

```bash
git clone https://github.com/krupalsai/student-platform-public.git
cd student-platform-public
```

### 2. Install dependencies

```bash
npm ci
```

### 3. Configure environment

Create a `.env.local` file in the project root with the values for your own Supabase project and the integrations you use. Never commit `.env.local` or any real keys.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase anon (public) key |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase service-role key (server only — never expose it) |
| `NEXT_PUBLIC_APP_URL` | Public URL of your deployment |
| `ADMIN_SECRET_KEY` | Secret for admin-only endpoints |
| `CRON_SECRET` | Secret for scheduled-job endpoints |
| `STUDENT_SESSION_TTL_DAYS` | Student login session length (default 30) |
| `ADMIN_SESSION_TTL_DAYS` | Admin login session length (default 7) |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_BUSINESS_ACCOUNT_ID` | WhatsApp Cloud API (bot + notifications) |
| `GEMINI_API_KEY`, `GROQ_API_KEY` | AI providers for the support bot |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web push notifications |
| `CLOUDFLARE_CALLS_APP_ID`, `CLOUDFLARE_CALLS_APP_SECRET` | Group voice/video calls |
| `SELF_HOSTED_AI_URL`, `SELF_HOSTED_AI_TOKEN` | Optional self-hosted AI fallback (see `ai-server/`) |
| `PHONEPE_WEBHOOK_SECRET` | PhonePe webhook verification (only if PhonePe is enabled) |

### 4. Set up the database

Apply the migrations in `supabase/migrations/` in order, using the Supabase CLI or the Supabase dashboard SQL editor, against your own project. The seed data in `supabase/seed-data/` is reference FAQ content for the support bot.

### 5. Run it

```bash
npm run dev
```

Open http://localhost:3000.

### 6. Build and test

```bash
npm run build    # production build (runs the prebuild checks first)
npm test         # vitest suite
npm run type-check
```

## Project structure

| Path | What's in it |
| --- | --- |
| `src/app/` | Pages and API routes (App Router) |
| `src/lib/` | Services: payments, auth, WhatsApp, bot/AI, notifications, storage |
| `src/components/` | Shared UI components |
| `src/middleware.ts` | Request middleware |
| `supabase/migrations/` | Versioned database changes |
| `supabase/seed-data/` | Reference FAQ seed data for the bot |
| `scripts/` | Maintenance scripts, checks, and test helpers |
| `tests/` | Vitest tests |
| `public/` | Static assets and the service worker |
| `android/` | Capacitor Android wrapper |
| `ai-server/` | Optional self-hosted AI server setup (Docker) |
| `.github/workflows/` | CI checks |

## Deployment

The app deploys to Vercel (`vercel.json` is included). Set the environment variables from the table above in the Vercel project settings — production secrets live in hosting settings, never in source code. A green build only proves the build completed; verify payments, login, WhatsApp, and notifications end to end before relying on them.

## License

See [LICENSE](LICENSE).
