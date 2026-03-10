param(
    [string]$Phone = '3572400170',
    [string]$EnvPath = '.env',
    [string]$TemplateName,
    [string]$LanguageCode
)

$ErrorActionPreference = 'Stop'

function Load-DotEnv {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        throw "No se encontró el archivo .env en: $Path"
    }

    $map = @{}
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line) { return }
        if ($line.StartsWith('#')) { return }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { return }

        $key = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()

        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        $map[$key] = $value
    }
    return $map
}

function Normalize-PhoneToWa {
    param([string]$RawPhone)

    if ([string]::IsNullOrWhiteSpace($RawPhone)) {
        throw 'El teléfono está vacío.'
    }

    $cleaned = ($RawPhone -replace '\D', '')
    if (-not $cleaned) {
        throw 'El teléfono no contiene dígitos válidos.'
    }

    if ($cleaned.StartsWith('549')) {
        return $cleaned
    }

    if ($cleaned.StartsWith('00')) {
        $cleaned = $cleaned.Substring(2)
    }

    if ($cleaned.StartsWith('54')) {
        $cleaned = $cleaned.Substring(2)
    }

    if ($cleaned.StartsWith('0')) {
        $cleaned = $cleaned.Substring(1)
    }

    if ($cleaned.StartsWith('15')) {
        $cleaned = $cleaned.Substring(2)
    }

    return '549' + $cleaned
}

try {
    $envVars = Load-DotEnv -Path $EnvPath

    $enabled = $envVars['WHATSAPP_ENABLED']
    if ($enabled -ne 'true') {
        throw 'WHATSAPP_ENABLED no está en true en el .env.'
    }

    $token = $envVars['WHATSAPP_TOKEN']
    $phoneNumberId = $envVars['WHATSAPP_PHONE_NUMBER_ID']

    if (-not $token) {
        throw 'Falta WHATSAPP_TOKEN en el .env.'
    }
    if (-not $phoneNumberId) {
        throw 'Falta WHATSAPP_PHONE_NUMBER_ID en el .env.'
    }

    if (-not $TemplateName) {
        $TemplateName = $envVars['WHATSAPP_TEMPLATE']
    }
    if (-not $LanguageCode) {
        $LanguageCode = $envVars['WHATSAPP_TEMPLATE_LANG']
    }

    if (-not $TemplateName) {
        $TemplateName = 'recordatorio_de_ubicacion'
    }
    if (-not $LanguageCode) {
        $LanguageCode = 'es_AR'
    }

    $waPhone = Normalize-PhoneToWa -RawPhone $Phone
    $uri = "https://graph.facebook.com/v21.0/$phoneNumberId/messages"

    $payload = @{
        messaging_product = 'whatsapp'
        to = $waPhone
        type = 'template'
        template = @{
            name = $TemplateName
            language = @{
                code = $LanguageCode
            }
        }
    } | ConvertTo-Json -Depth 10

    Write-Host "Enviando plantilla '$TemplateName' ($LanguageCode) a $waPhone ..." -ForegroundColor Cyan

    $response = Invoke-RestMethod -Method Post -Uri $uri -Headers @{
        Authorization = "Bearer $token"
        'Content-Type' = 'application/json'
    } -Body $payload

    Write-Host 'Envio OK' -ForegroundColor Green
    $response | ConvertTo-Json -Depth 10
}
catch {
    Write-Host 'Fallo el envío de prueba.' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Yellow
    exit 1
}
