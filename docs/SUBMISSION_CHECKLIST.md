# Waypoint — Hackathon Submission Checklist

> [!IMPORTANT]
> Complete every item below before final form submission.
> The hard deadline is 9:00 PM for code/build commits, with the final form submission closing at 10:00 PM.

---

## 1. Rulebook Section 16 Mandatory Deliverables

| Deliverable | Requirement | Status | Notes |
|---|---|---|---|
| **Live Deployed URL** | Publicly accessible URL, no login required | ⬜ Pending deploy | Single-container Docker service on Render / Railway |
| **Demo Video** | Hosted video (YouTube / Loom) under 7:00 | ⬜ Pending recording | Target 6:30 per `docs/DEMO_SCRIPT.md` |
| **Pitch Deck / Slides** | Presentation deck (PDF / PPTX) covering problem & architecture | ⬜ Pending export | 11 slides matching `docs/PPT_OUTLINE.md` |
| **GitHub Repository** | Public repo (or accessible to judging panel) | ✅ Ready | Clean commit history, no secrets |
| **Documentation & README** | Clear setup guide, architecture, and measured facts | ✅ Ready | All claims synced with `docs/MEASURED_FACTS.md` |
| **Clean License Audit** | Permissive licenses logged in `THIRD_PARTY.md` | ✅ Complete | Zero GPL / unlicensed code |

---

## 2. Pre-Submission Hygiene & Operational Checks

| Check | Action Required | Status |
|---|---|---|
| **Secrets Scan** | Run `git log` and bundle audit for API keys / passwords | ✅ Verified clean (0 secrets leaked) |
| **Auto-Deploy Disabled** | Turn OFF automatic deploy on Render / Railway to freeze container | ⬜ Check host dashboard before 9 PM |
| **Instance Count** | Ensure exactly `1` instance is configured on host | ⬜ Check host settings (in-memory locks) |
| **Incognito Verification** | Open deployed URL in incognito browser: `/guide` steps 1 to 6 pass | ⬜ Verify immediately after host deploy |
| **Commit Hygiene** | All docs and code pushed before the 9:00 PM code freeze | ⬜ Push before 9:00 PM |

---

## 3. Ready-to-Paste Form Fields

### Project Name
```text
Waypoint: Failure Attribution & Episodic Preflight Guard for LLM Agents
```

### Short Description (1-2 Sentences)
```text
Waypoint is a flight recorder and regression guard for AI agents that detects silent tool-call failures, isolates culprit updates via factorial replay and Shapley blame attribution, and prevents repeat regressions using MongoDB episodic memory.
```

### Access Instructions for Judges (Paste Verbatim)
```text
1. Open the live URL: <DEPLOYED_URL>/guide
2. No login or configuration is required; each visitor is automatically provisioned an isolated per-session sandbox.
3. Follow the 6-step interactive workflow on /guide to witness clean baseline mining, silent regression detection, factorial Shapley attribution, and the preflight BLOCK finale.
4. Note: The demo agent is simulated with a seeded PRNG for 100% reproducible evaluations. If rapid clicks trigger Voyage API rate limits, the system transparently falls back to lexical matching without interruption.
```

### GitHub Repository URL
```text
https://github.com/Siddh-2006/WayPoint
```

---

## 4. Final Submission Steps

1. [ ] Check host dashboard: verify health check `/health` returns `ok: true`.
2. [ ] Click through `/guide` steps 1 to 6 on the live production URL in an incognito window.
3. [ ] Confirm demo video is unlisted or public and audio is clear.
4. [ ] Paste access instructions into the submission portal.
5. [ ] Submit before the 10:00 PM final portal close.
