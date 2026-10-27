# Shared discovery for ordinary Node installations and the bundled desktop runtime.
function Get-TomorrowNodeTools {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Node.js 22.19 or newer is required for Pi.' }
    $nodePath = $nodeCommand.Source
    $nodeDirectory = Split-Path -Parent $nodePath
    $pnpmScript = @(
        (Join-Path $nodeDirectory 'node_modules/pnpm/bin/pnpm.mjs'),
        (Join-Path $nodeDirectory '../node_modules/pnpm/bin/pnpm.mjs')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpmScript -and -not $pnpmCommand) { throw 'pnpm 10 is required. Install pnpm, then retry.' }
    @{ Node=$nodePath; PnpmScript=$pnpmScript; PnpmCommand=$pnpmCommand }
}
function Invoke-TomorrowPnpm {
    param($Tools, [string[]]$Arguments)
    if ($Tools.PnpmScript) { & $Tools.Node $Tools.PnpmScript @Arguments }
    else { & $Tools.PnpmCommand.Source @Arguments }
    if ($LASTEXITCODE -ne 0) { throw 'Pi dependency installation or TypeScript build failed.' }
}
