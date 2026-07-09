# ============================================================
# Setup do sync automatico TGA -> Supabase (rodar NO SERVIDOR)
# 1) Limpa run_sync_all.py (remove refresh de MVs obsoletas)
# 2) Registra tarefa agendada a cada 10 minutos
# ============================================================

$ErrorActionPreference = "Stop"
$BASE = "C:\sync_tga_dashboard"
$RSA  = Join-Path $BASE "run_sync_all.py"

Write-Host "==== 1) Limpando run_sync_all.py ===="
$content = Get-Content $RSA -Raw
# Zera a lista de materialized views obsoletas (elas nao existem mais no Supabase)
$content = [System.Text.RegularExpressions.Regex]::Replace(
    $content,
    'MATERIALIZED_VIEWS\s*=\s*\[[^\]]*\]',
    'MATERIALIZED_VIEWS = []'
)
# Grava sem BOM
[System.IO.File]::WriteAllText($RSA, $content, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "run_sync_all.py atualizado. Confirmando:"
Select-String -Path $RSA -Pattern "MATERIALIZED_VIEWS ="

Write-Host ""
Write-Host "==== 2) Descobrindo o Python ===="
$py = (Get-Command python).Source
Write-Host "Python encontrado em: $py"

Write-Host ""
Write-Host "==== 3) Registrando tarefa agendada (a cada 10 min) ===="
$task = "TGA_Sync_Dashboard"
$acao = "`"$py`" `"$RSA`""

# Cria a tarefa rodando como SYSTEM (roda mesmo sem ninguem logado)
schtasks /Create /TN $task /TR $acao /SC MINUTE /MO 10 /RU SYSTEM /RL HIGHEST /F

Write-Host ""
Write-Host "==== 4) Rodando a tarefa uma vez para testar ===="
schtasks /Run /TN $task
Start-Sleep -Seconds 45

Write-Host ""
Write-Host "==== 5) Status da tarefa (procure 'Ultimo resultado: 0') ===="
schtasks /Query /TN $task /V /FO LIST

Write-Host ""
Write-Host "==== 6) Ultimo log gerado ===="
$ultimoLog = Get-ChildItem (Join-Path $BASE "logs") -Filter "sync_*.log" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host "Log: $($ultimoLog.FullName)"
Get-Content $ultimoLog.FullName | Select-String "Movimentos encontrados|Itens de venda encontrados|CICLO CONCLUIDO"
