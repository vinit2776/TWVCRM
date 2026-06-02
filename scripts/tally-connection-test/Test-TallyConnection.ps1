<#
  Test-TallyConnection.ps1
  -------------------------
  A standalone CONNECTION TEST between a machine and Tally Prime's XML gateway.
  It changes NOTHING in Tally and NOTHING in the CRM. It only asks Tally
  "are you there?" and "which companies are open?" and reports the result.

  WHAT IT PROVES
    1. Tally is listening on the network port (gateway is ON).
    2. Tally accepts an XML request and replies with valid data.
    3. (When run from another PC) the office network path works.

  HOW TO RUN  (on the Windows machine where Tally is installed)
    1. Open Tally Prime and load your company.
    2. Turn the gateway on once:  F1 (Help) > Settings > Connectivity >
       Client/Server configuration > "TallyPrime acts as" = Both,
       Port = 9000.  (One-time setting.)
    3. Right-click this file > "Run with PowerShell"
       OR open PowerShell and run:
         powershell -ExecutionPolicy Bypass -File .\Test-TallyConnection.ps1

    To test FROM ANOTHER office PC, pass the Tally machine's IP:
         .\Test-TallyConnection.ps1 -TallyHost 192.168.1.50
#>

param(
  [string]$TallyHost = "localhost",
  [int]$Port = 9000
)

$ErrorActionPreference = "Stop"
$url = "http://{0}:{1}" -f $TallyHost, $Port

Write-Host ""
Write-Host "==================================================="  -ForegroundColor Cyan
Write-Host "  TWV CRM  <->  Tally   Connection Test"             -ForegroundColor Cyan
Write-Host "==================================================="  -ForegroundColor Cyan
Write-Host ("  Target : {0}" -f $url)
Write-Host ("  Time   : {0}" -f (Get-Date))
Write-Host ""

# ---------------------------------------------------------------
# STEP 1 - Is anything listening on the Tally port?
# ---------------------------------------------------------------
Write-Host "[1/2] Checking if Tally is listening on port $Port ..."
try {
  $tcp = Test-NetConnection -ComputerName $TallyHost -Port $Port -WarningAction SilentlyContinue
  if (-not $tcp.TcpTestSucceeded) {
    Write-Host "  RESULT: FAILED - nothing is listening on $TallyHost`:$Port" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Likely causes:" -ForegroundColor Yellow
    Write-Host "   - Tally Prime is not open." -ForegroundColor Yellow
    Write-Host "   - The gateway is off (F1 > Settings > Connectivity)." -ForegroundColor Yellow
    Write-Host "   - A firewall is blocking port $Port (if testing from another PC)." -ForegroundColor Yellow
    exit 1
  }
  Write-Host "  RESULT: OK - port $Port is open and accepting connections." -ForegroundColor Green
}
catch {
  Write-Host ("  RESULT: FAILED - {0}" -f $_.Exception.Message) -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------
# STEP 2 - Ask Tally for the list of open companies (read-only).
#          This proves the XML gateway actually parses & replies.
# ---------------------------------------------------------------
Write-Host ""
Write-Host "[2/2] Asking Tally for the list of open companies ..."

# Note: `$`$SysName escapes the Tally $$ syntax so PowerShell does not touch it.
$requestXml = @"
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>List of Companies</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="List of Companies" ISMODIFY="No">
            <TYPE>Company</TYPE>
            <NATIVEMETHOD>Name</NATIVEMETHOD>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
"@

try {
  $response = Invoke-WebRequest -Uri $url -Method Post -Body $requestXml `
                -ContentType "text/xml" -TimeoutSec 15 -UseBasicParsing
  $content = $response.Content

  if ([string]::IsNullOrWhiteSpace($content)) {
    Write-Host "  RESULT: WARNING - Tally replied but the response was empty." -ForegroundColor Yellow
    Write-Host "  -> Usually means no company is loaded. Open a company in Tally and retry." -ForegroundColor Yellow
    exit 2
  }

  if ($content -match "<LINEERROR>(.*?)</LINEERROR>") {
    Write-Host ("  RESULT: Tally replied with an error: {0}" -f $Matches[1]) -ForegroundColor Yellow
    Write-Host "  -> The connection WORKS, but check that a company is open." -ForegroundColor Yellow
    exit 2
  }

  # Pull out company names from the XML reply.
  $names = [System.Collections.Generic.List[string]]::new()
  foreach ($m in [regex]::Matches($content, "<NAME>(.*?)</NAME>")) {
    $names.Add($m.Groups[1].Value)
  }

  Write-Host "  RESULT: OK - Tally responded successfully!" -ForegroundColor Green
  Write-Host ""
  Write-Host "  -------------------------------------------" -ForegroundColor Cyan
  Write-Host "   Companies currently open in Tally:" -ForegroundColor Cyan
  if ($names.Count -gt 0) {
    foreach ($n in ($names | Select-Object -Unique)) {
      Write-Host ("     - {0}" -f $n) -ForegroundColor White
    }
  } else {
    Write-Host "     (Tally replied, but no company names were parsed." -ForegroundColor Yellow
    Write-Host "      Connection is fine; a company may just not be loaded.)" -ForegroundColor Yellow
  }
  Write-Host "  -------------------------------------------" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "  >>> CONNECTION TEST PASSED. The pipe between this machine"  -ForegroundColor Green
  Write-Host "      and Tally works. No network or software blockers."       -ForegroundColor Green
}
catch {
  Write-Host ("  RESULT: FAILED - {0}" -f $_.Exception.Message) -ForegroundColor Red
  Write-Host ""
  Write-Host "  The port was open but Tally did not answer the XML request." -ForegroundColor Yellow
  Write-Host "  -> Confirm 'TallyPrime acts as' = Both/Server and a company is open." -ForegroundColor Yellow
  exit 1
}

Write-Host ""
