---
paths:
  - "dashboard.html"
  - "admin.html"
  - "new.html"
  - "settings.html"
  - "index.html"
  - "404.html"
  - "api/admin.js"
  - "api/send-email.js"
---

# Admin UX — Self-Serve Rules for Non-Tech NGO Admins

Applies to all dashboard / admin UI work and admin-related backend code.

## Audience

NGO admins / community managers, **30s–50s, NOT tech-savvy, NOT early
adopters.** They will not figure out a confusing UI.

**Mandate:** the customer must complete this entire flow **alone**,
without asking the founder:

1. Create a project, fill the brief, upload a hero image
2. Generate variants and wait through AI generation (with clear progress
   feedback — not just a spinner)
3. Preview each generated LP and obviously distinguish "draft" from
   "published"
4. Name variants meaningfully — suggest names like "Emotional Origin"
   vs "Stat-Driven" — never just "Variant A"
5. Copy a URL ready to paste into FB / Google Ads Manager (with UTM
   placeholder)
6. Edit the brief and regenerate without losing previous variants

Anywhere this flow needs explanation, the UI is broken.

---

## UX Prime Directives

1. **Forgiveness by default.** Every destructive action undoable.
   Soft delete + undo toast beats "Are you sure?" modals.
2. **Progressive disclosure.** Minimum controls by default; "advanced"
   hidden behind a toggle. Empty states teach the next step.
3. **Primary action per screen.** One obvious dominant CTA; secondary
   actions visually quieter.
4. **Warm + casual Hebrew.** Invoke the `hebrew-content-writer` skill
   for any UI copy. Never use English tech words in user-facing text.
5. **Onboarding = visible checklist.** First login: "Create project →
   Fill brief → Upload image → Generate variants." Items tick off as
   completed. Persistent. Not a tour, not a modal.

---

## AI generation UX (the slow step)

The AI generation step takes 20–60 seconds. **A spinner alone is brutal**
for non-tech users — they assume it broke and refresh.

Required:
- **Progress message that changes** ("מבין את התקציר…", "כותב את הטקסט…",
  "מעצב את הדף…") — invoke `hebrew-content-writer` for the actual copy
- **Estimated time remaining** (or "~30 שניות נותרו")
- **Cancellable** with confirmation
- **On error:** human Hebrew message + a way to retry, NEVER a stack trace
