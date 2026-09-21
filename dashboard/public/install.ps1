# Installs the railcast CLI on Windows.
#   irm https://railcast.casablanque.com/install.ps1 | iex
# Mirrors install.sh — same repo, same release tags, same binary-naming
# scheme (see .github/workflows/release.yml) — just the Windows side of it.

$ErrorActionPreference = "Stop"

$Repo = "casablanque-code/railcast"
$InstallDir = Join-Path $env:USERPROFILE ".railcast\bin"
$BinPath = Join-Path $InstallDir "railcast.exe"

# Only amd64 Windows builds are published today (see release.yml's matrix) —
# arm64 Windows machines can still run the amd64 binary under emulation,
# so this doesn't hard-fail there, it just says so.
$arch = "amd64"
if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -and -not $env:PROCESSOR_ARCHITEW6432) {
    Write-Warning "No native arm64 Windows build yet — installing the amd64 build, which runs fine under Windows' x64 emulation."
}

Write-Host "Finding the latest release..."
try {
    $release = Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$Repo/releases/latest"
} catch {
    Write-Error "railcast install: couldn't reach GitHub to find the latest release — download a binary manually from https://github.com/$Repo/releases"
    exit 1
}
$tag = $release.tag_name
if (-not $tag) {
    Write-Error "railcast install: couldn't determine the latest release — download a binary manually from https://github.com/$Repo/releases"
    exit 1
}

$url = "https://github.com/$Repo/releases/download/$tag/railcast-$tag-windows-$arch.exe"
Write-Host "Downloading railcast $tag for windows/$arch..."

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$tmpPath = "$BinPath.download"
try {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tmpPath
} catch {
    Remove-Item -Force -ErrorAction SilentlyContinue $tmpPath
    Write-Error "railcast install: couldn't download $url — that release may not include a windows/$arch build."
    exit 1
}
Move-Item -Force $tmpPath $BinPath

Write-Host "Installed to $BinPath"

# Persist to the user's PATH (not just this session) the same way install.sh
# edits .zshrc/.bashrc — but idempotently, so re-running this doesn't pile up
# duplicate entries.
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
    Write-Host "Added $InstallDir to your PATH (User scope)."
    Write-Host ""
    Write-Host "Open a new terminal and run:"
} else {
    Write-Host ""
    Write-Host "$InstallDir is already on your PATH. Run:"
}
Write-Host "  railcast version"
