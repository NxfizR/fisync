# Sends this computer's address over Bluetooth LE as a service ID, so nearby phones can find it.
# Started by fisync when "nearby Bluetooth" is on. The beacon holds no keys and no names.
# Untested on Windows hardware at the time of writing: please report what happens.
param([Parameter(Mandatory = $true)][string]$BeaconFile)

$ErrorActionPreference = 'Stop'
$publisher = New-Object Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementPublisher

# The 16-byte beacon, written as a standard UUID.
function Get-BeaconGuid([string]$hex) {
    return [guid]("{0}-{1}-{2}-{3}-{4}" -f $hex.Substring(0, 8), $hex.Substring(8, 4), $hex.Substring(12, 4), $hex.Substring(16, 4), $hex.Substring(20, 12))
}

function Set-Beacon([string]$hex) {
    $publisher.Stop()
    $publisher.Advertisement.ServiceUuids.Clear()
    [void]$publisher.Advertisement.ServiceUuids.Add((Get-BeaconGuid $hex))
    $publisher.Start()
}

$last = ''
try {
    while ($true) {
        if (Test-Path $BeaconFile) {
            $beacon = Get-Content $BeaconFile -Raw | ConvertFrom-Json
            if ($beacon.hex -and $beacon.hex.Length -eq 32 -and $beacon.hex -ne $last) {
                Set-Beacon $beacon.hex
                $last = $beacon.hex
            }
        }
        Start-Sleep -Seconds 20
    }
} finally {
    $publisher.Stop()
}
