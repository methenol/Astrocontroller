---
name: skill-writing
description: How and when to create or update skills and NOTES.md so lessons carry over to future sessions.
---
# Writing skills

**When**
- A task needed trial and error, and you found what works.
- A command failed with a firmware quirk and you found the workaround.
- The user stated a preference ("I prefer 30 s subs on the Veil", "trees block the west below 35°").
- You measured something (nudge speed, sign conventions, transfer speed, typical reject rate).

**How**
- One skill per repeatable task, in `.omp/skills/<kebab-name>/SKILL.md` with frontmatter `name` and a one-line `description` that says *when* to use it.
- Use `edit` for small changes. Keep skills short: checklists, tables, exact tool calls with arguments that worked, and a "Learned" section with dated one-liners such as `2026-10-03: 15 s/g60 Duo-Band on NGC 7000 → 4% rejects`.
- Remove or correct advice that turned out wrong; don't let skills drift into logs.
- Site/equipment/user facts go in `NOTES.md` (not a skill).
- Tell the user in one line what you saved.
