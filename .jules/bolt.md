## 2026-03-10 - Home Dashboard Tilt Events
**Learning:** The home dashboard repo-card tilt effect was updating CSS variables on every raw `mousemove` event, which made hover animation cost scale with input frequency instead of display refresh rate.
**Action:** When adding pointer-driven visual polish in this codebase, batch DOM reads and style writes through `requestAnimationFrame` so decorative effects stay frame-bound and do not overschedule work.
