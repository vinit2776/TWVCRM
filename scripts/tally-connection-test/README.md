# Tally Connection Test

A **read-only connection tester** between a machine and Tally Prime's XML gateway.

It changes **nothing** in Tally and **nothing** in the CRM. It only asks Tally
"are you there?" and "which companies are open?" — to prove the network + software
pipe works *before* we build the real integration.

This is a throwaway diagnostic, not part of the app. It is safe to run any number
of times.

---

## What it proves

1. Tally is listening on its gateway port (the gateway is switched on).
2. Tally accepts an XML request and replies with valid data.
3. (When run from a second PC) the office network path to Tally works.

---

## One-time Tally setup

1. Open **Tally Prime** and **load your company**.
2. Turn the gateway on (one time):
   **F1 (Help) → Settings → Connectivity → Client/Server configuration**
   - **TallyPrime acts as:** `Both`
   - **Port:** `9000`
3. Leave Tally open.

> No Tally username/password is needed — the gateway does not ask for one.
> The company just needs to be open on screen.

---

## How to run

### Option A — On the Windows Tally machine (recommended first test)

Right-click `Test-TallyConnection.ps1` → **Run with PowerShell**, or:

```powershell
powershell -ExecutionPolicy Bypass -File .\Test-TallyConnection.ps1
```

### Option B — From another machine on the same office network

Find the Tally machine's IP (on it, run `ipconfig` → IPv4 Address), then:

```powershell
.\Test-TallyConnection.ps1 -TallyHost 192.168.1.50
```

or, on a Mac/Linux box with Node installed:

```bash
node test-tally.mjs 192.168.1.50
```

---

## Reading the result

- **CONNECTION TEST PASSED** + a list of company names → everything works. ✅
- **Port not open / connection refused** → Tally isn't open, or the gateway is off.
- **Timed out** → port reachable but gateway not answering; check "acts as = Both".
- **Empty reply / LINEERROR** → connection works, but no company is loaded — open one.

---

## Important

- This test runs on your **office LAN only**. It **cannot** run from the cloud CRM
  (Vercel) — bridging that gap is the job of the full connector we build later.
- Default port is `9000`. If you set a different port in Tally, pass it as the
  second argument.
