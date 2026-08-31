# Example: Cross-Session Recovery with claude-task-store

This example shows a concrete session-A → session-B handoff.

## Scenario

**Task:** Implement a REST API with authentication  
**Session A:** Completes steps 1-2, fails an approach on step 3, exits  
**Session B:** Starts cold (no history), reads task store, resumes correctly

---

## Session A

```
User: Let's implement the authentication API. 5 steps:
1. User model
2. JWT generation  
3. Login endpoint
4. Token refresh
5. Integration tests
```

Claude uses the task-store skill:

```bash
$ task-store init "Implement REST authentication API" \
    "Create User model with bcrypt password hashing" \
    "Implement JWT token generation and validation" \
    "Add /auth/login and /auth/logout endpoints" \
    "Implement token refresh flow" \
    "Write integration tests"

✓ Initialized task store for: Implement REST authentication API
  5 task(s) created
```

### Claude completes T1

```bash
$ task-store start T1
$ # ... implements src/models/user.ts ...
$ task-store done T1 -e src/models/user.ts -e "npm test: User model tests 8/8 pass"

✓ Completed [T1]
  Next: Start task T2: Implement JWT token generation and validation
```

### Claude completes T2

```bash
$ task-store start T2
$ # ... implements src/auth/jwt.ts ...
$ task-store done T2 -e src/auth/jwt.ts -e "REPL: jwt.sign/verify works correctly"
```

### Claude starts T3, hits a problem

```bash
$ task-store start T3
$ # ... tries express-session ...
$ # ... doesn't work with JWT stateless design ...
$ task-store attempt T3 \
    "express-session middleware for login state" \
    "Conflicts with JWT stateless design; no session store in production"
$ task-store next "Implement /auth/login using JWT only: POST body { email, password } → { token, refreshToken }"
```

### Session A ends

The `SessionEnd` hook fires. Since `next_action` is set, no warning. State persisted.

---

## Gap: Context compaction or session restart

**Session B starts with NO conversation history.**

---

## Session B — Cold Start

The `SessionStart` hook fires and injects:

```
╔══════════════════════════════════════╗
║  TASK STORE — RESUME CONTEXT         ║
╚══════════════════════════════════════╝

GOAL: Implement REST authentication API
STATUS: ACTIVE

CURRENT:
  ▶ [T3] Add /auth/login and /auth/logout endpoints
    ✗ tried: express-session middleware for login state → Conflicts with JWT 
      stateless design; no session store in production

DONE:
  ✓ [T1] Create User model with bcrypt password hashing
  ✓ [T2] Implement JWT token generation and validation

REMAINING:
  ○ [T4] Implement token refresh flow
  ○ [T5] Write integration tests

NEXT ACTION: Implement /auth/login using JWT only: POST body { email, password } 
             → { token, refreshToken }

Updated: 2026-08-31 09:14 UTC
─── /task-status for details | /task-history for audit ───
```

**Injected: 743 chars ≈ 185 tokens**

Claude resumes:

> "I can see the current state. T1 (User model) and T2 (JWT) are complete. I'm working on T3 (login endpoint). The express-session approach was already tried and failed because it conflicts with JWT stateless design. I'll implement the login endpoint using JWT only.
>
> Let me implement `POST /auth/login`:

```typescript
// src/routes/auth.ts
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findByEmail(email);
  if (!user || !await user.verifyPassword(password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: '15m' });
  const refreshToken = jwt.sign({ userId: user.id }, process.env.JWT_REFRESH_SECRET!, { expiresIn: '7d' });
  res.json({ token, refreshToken });
});
```

After implementing:

```bash
$ task-store done T3 \
    -e src/routes/auth.ts \
    -e "POST /auth/login returns 200 with token+refreshToken (tested in Postman)"
```

**Result:** Session B correctly resumes from exactly where Session A stopped, without:
- Re-reading any transcripts
- Re-implementing T1 or T2
- Repeating the failed express-session approach
- Any context overhead beyond 185 tokens

---

## Measurements

| Metric | Value |
|--------|-------|
| Resume context size | 743 chars |
| Estimated tokens | ~185 |
| Files read to resume | 1 (`state.json`) |
| Previously completed work repeated | None |
| Failed approach repeated | None |
| Token budget used | 185 / 800 (23%) |

---

## Git-Based Cross-Developer Handoff

If `state.json` is committed:

```bash
# Developer A commits state
git add .claude-task/state.json
git commit -m "chore: task state - T1,T2 done, T3 in progress"
git push

# Developer B (or another Claude session) pulls and resumes
git pull
# SessionStart hook auto-injects the state
claude  # ← resumes automatically from the checkpoint
```

This works across:
- Different machines
- Different developers  
- Different Claude models (e.g., Sonnet → Haiku → Sonnet)
- Context compaction events
- Session restarts
