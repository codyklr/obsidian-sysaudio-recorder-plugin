$ErrorActionPreference = "Stop"

$version = Read-Host -Prompt "Enter version number (e.g. 1.0.1)"
if ([string]::IsNullOrWhiteSpace($version)) {
    Write-Error "Version number is required."
}

$manifestPath = "manifest.json"
if (Test-Path $manifestPath) {
    $manifest = Get-Content $manifestPath | ConvertFrom-Json
    $manifest.version = $version
    $manifest | ConvertTo-Json -Depth 10 | Set-Content $manifestPath
    Write-Host "Updated manifest.json to version $version"
} else {
    Write-Warning "manifest.json not found, skipping version update."
}

Write-Host "Building project..."
npm run build

$releaseDir = "obsidian-sysaudio-recorder"
$zipFile = "obsidian-sysaudio-recorder.zip"

# Clean up previous build artifacts
if (Test-Path $releaseDir) {
    Remove-Item -Path $releaseDir -Recurse -Force
}
if (Test-Path $zipFile) {
    Remove-Item -Path $zipFile -Force
}

# Create release directory
New-Item -ItemType Directory -Path $releaseDir | Out-Null

# Copy files
$filesToCopy = @("main.js", "styles.css", "control-window.html", "manifest.json")
foreach ($file in $filesToCopy) {
    if (Test-Path $file) {
        Copy-Item -Path $file -Destination $releaseDir
    } else {
        Write-Warning "File not found: $file"
    }
}

# Create Zip file
Write-Host "Creating zip archive..."
Compress-Archive -Path $releaseDir -DestinationPath $zipFile

# Clean up release directory
Remove-Item -Path $releaseDir -Recurse -Force

Write-Host "Release build created: $zipFile"
