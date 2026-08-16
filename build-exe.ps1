# build-exe.ps1 — Builds VideoEditStudio.exe using Node.js SEA
# Run from the video_edit project root:
#   powershell -ExecutionPolicy Bypass -File build-exe.ps1

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$Signtool = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"
$NodeExe  = (Get-Command node).Source
$NpmCli   = "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"
$OutExe   = Join-Path $ProjectDir "VideoEditStudio.exe"
$Blob     = Join-Path $ProjectDir "sea-prep.blob"

Write-Host ""
Write-Host "  ╔════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║   🔨 Building VideoEditStudio.exe   ║" -ForegroundColor Cyan
Write-Host "  ╚════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Generate SEA blob ─────────────────────────────────────────────────
Write-Host "  [1/4] Generating SEA blob..." -ForegroundColor Yellow
node --experimental-sea-config sea-config.json
Write-Host "        ✅ sea-prep.blob created`n"

# ── Step 2: Copy node.exe ─────────────────────────────────────────────────────
Write-Host "  [2/4] Copying node.exe -> VideoEditStudio.exe..." -ForegroundColor Yellow
if (Test-Path $OutExe) { Remove-Item $OutExe -Force }
Copy-Item $NodeExe $OutExe
Write-Host "        ✅ Copied ($([math]::Round((Get-Item $OutExe).Length / 1MB, 1)) MB)`n"

# ── Step 3: Remove Microsoft signature ───────────────────────────────────────
Write-Host "  [3/4] Removing signature from exe..." -ForegroundColor Yellow
& $Signtool remove /s $OutExe | Out-Null
Write-Host "        ✅ Signature removed`n"

# ── Step 4: Inject launcher blob ─────────────────────────────────────────────
Write-Host "  [4/4] Injecting launcher blob..." -ForegroundColor Yellow
node $NpmCli exec -y -- postject $OutExe NODE_SEA_BLOB $Blob `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 `
  --overwrite
Write-Host "        ✅ Injection complete`n"

$SizeMB = [math]::Round((Get-Item $OutExe).Length / 1MB, 1)
Write-Host "  🎉  Done! VideoEditStudio.exe ($SizeMB MB)" -ForegroundColor Green
Write-Host "      Double-click it to launch the Video Edit Studio.`n"
