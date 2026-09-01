# ADMS device relay

A tiny stateless proxy that lets the office ZKTeco K40 Pro keep working after the
app moved to the cloud. The device only speaks plain HTTP to a local IP, so it
can't reach an HTTPS domain directly. This relay runs on the office Windows
machine, accepts the device's local pushes, and forwards them to the cloud app
over HTTPS.

**Reliability:** it passes the cloud's response straight back to the device, so
the device only clears a log once the cloud has accepted it. If the internet or
the cloud is down, the device gets no `OK` and retries later — nothing is lost.
The relay holds no queue of its own; the device's built-in buffer is the durable
store. Run it as an auto-starting service so it recovers on reboot.

## Configure the device
Point the K40 Pro's `Menu → Comm → ADMS` at **this machine's LAN IP** and the
relay's port (default `3001`) — exactly like it currently points at the local app.
Nothing else on the device changes.

## Quick setup: `setup-relay.ps1`
[`setup-relay.ps1`](setup-relay.ps1) automates everything below — checks for
Node.js and NSSM, copies this folder to `C:\AttendanceRelay`, and installs the
`AttendanceRelay` service. Copy this whole `relay/` folder to the office
machine, then in an **Administrator** PowerShell window, from inside it:

```powershell
# first run — signed-script policy blocks .ps1 by default, so bypass it for this one invocation
powershell -ExecutionPolicy Bypass -File .\setup-relay.ps1 -NssmPath "C:\path\to\nssm.exe"
```

It only **installs** the service by default — it does not stop the existing
local `AttendanceGateway` service or start the relay, since that would cut the
office's live attendance capture over to the cloud immediately. Re-run with
`-Cutover` only when you're actually ready to switch over:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-relay.ps1 -NssmPath "C:\path\to\nssm.exe" -Cutover
```

NSSM itself isn't downloaded by the script — grab `nssm.exe` yourself from
<https://nssm.cc/download> first. Run `.\setup-relay.ps1 -?` for every
parameter (install directory, cloud URL, port).

The rest of this file explains what the script does, if you'd rather run the
steps by hand.

## Run it (Windows, as an NSSM service)
Node 18+ is enough (no dependencies). Copy the `relay/` folder to the machine,
e.g. `C:\AttendanceRelay\`, then in an **Administrator** command prompt:

```
:: install (single line; use the real nssm.exe path)
"C:\nssm-2.24\nssm-2.24\win64\nssm.exe" install AttendanceRelay "C:\Program Files\nodejs\node.exe" "C:\AttendanceRelay\relay.js"

:: point it at the cloud app and set the listen port — use the plain Vercel URL
:: for now (see note below), not the custom domain
"C:\nssm-2.24\nssm-2.24\win64\nssm.exe" set AttendanceRelay AppEnvironmentExtra "CLOUD_URL=https://twv-attendance.vercel.app" "RELAY_PORT=3001"
"C:\nssm-2.24\nssm-2.24\win64\nssm.exe" set AttendanceRelay AppDirectory "C:\AttendanceRelay"
"C:\nssm-2.24\nssm-2.24\win64\nssm.exe" set AttendanceRelay AppStdout "C:\AttendanceRelay\relay.log"
"C:\nssm-2.24\nssm-2.24\win64\nssm.exe" set AttendanceRelay AppStderr "C:\AttendanceRelay\relay.log"

:: start
"C:\nssm-2.24\nssm-2.24\win64\nssm.exe" start AttendanceRelay
```

> Note: the current `AttendanceGateway` NSSM service (the old local app on port
> 3001) must be **stopped/removed first**, or free up port 3001, since the relay
> takes over that port. Do this only at cutover, once the cloud app is live.

## Environment variables
| Name | Default | Purpose |
|---|---|---|
| `CLOUD_URL` | *(required)* | Cloud app base URL, e.g. `https://twv-attendance.vercel.app` |
| `RELAY_PORT` | `3001` | Local port the device pushes to |

> **`attendance.theworkvilla.com` is not usable as `CLOUD_URL` right now** — that
> hostname is currently still pointed at an unrelated deployment under a
> different Vercel account, not this project. Use `https://twv-attendance.vercel.app`
> until the domain is reclaimed and re-added to the `twv-attendance` project;
> see `docs/data-migration.md` and the project notes for the current status.

## Verify
From any device on the office LAN:
```
curl http://<machine-LAN-IP>:3001/health
```
should return `{"ok": true}` served by the cloud through the relay.
