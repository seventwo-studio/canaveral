# Private guest helper: fixed source, framed stdio, no listener or script input.
$ErrorActionPreference = 'Stop'
try {
    if (-not [Environment]::Is64BitProcess -or [Environment]::OSVersion.Version.Build -lt 14393) { exit 1 }
    $framework = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
    $references = @('System.dll', 'System.Core.dll', 'System.Web.Extensions.dll', 'System.Drawing.dll',
        (Join-Path $framework 'WPF\UIAutomationClient.dll'),
        (Join-Path $framework 'WPF\UIAutomationTypes.dll'),
        (Join-Path $framework 'WPF\WindowsBase.dll'))
    Add-Type -Path (Join-Path $PSScriptRoot 'native.cs') -ReferencedAssemblies $references
    [Canaveral.Windows.NativeBridge]::Serve()
} catch { exit 1 }
