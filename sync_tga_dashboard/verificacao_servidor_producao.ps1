# =====================================================================
# VERIFICACAO SOMENTE LEITURA - rodar NO SERVIDOR onde o TGA esta instalado
# (C:\TGA, processos Estoque.exe / Financeiro.exe)
#
# Este script NAO faz UPDATE, DELETE, INSERT, ALTER, DROP, backup,
# restore, copia, move ou renomeia nenhum arquivo do TGA/Firebird.
# Usa SET TRANSACTION READ ONLY e ROLLBACK no final da consulta SQL.
# =====================================================================

$dbCandidato = "C:\Users\Administrador\Desktop\GGFRUTAL.FDB"
$pastaTGA    = "C:\TGA"
$isql        = "C:\Program Files\Firebird\Firebird_2_5\bin\isql.exe"
$fbUser      = "SYSDBA"
$fbPassword  = "masterkey"

Write-Output "===== 1. Processos Estoque.exe / Financeiro.exe (linha de comando) ====="
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -match 'Estoque|Financeiro' } |
    Select-Object ProcessId, Name, CommandLine |
    Format-List

Write-Output ""
Write-Output "===== 2. Arquivos de config em C:\TGA citando GGFRUTAL ou .FDB ====="
Get-ChildItem -Path $pastaTGA -Recurse -Include *.ini,*.cfg,*.conf,*.txt,*.xml,*.json,*.dat -ErrorAction SilentlyContinue |
    Select-String -Pattern "GGFRUTAL|\.FDB" -ErrorAction SilentlyContinue |
    Select-Object Path, LineNumber, Line |
    Format-Table -Wrap

Write-Output ""
Write-Output "===== 3. Conexoes TCP ativas na porta 3050 (Firebird) ====="
Get-NetTCPConnection -LocalPort 3050 -ErrorAction SilentlyContinue | Format-Table -AutoSize

Write-Output ""
Write-Output "===== 4. Consulta SOMENTE LEITURA direto no GGFRUTAL.FDB candidato ====="

if (-not (Test-Path $dbCandidato)) {
    Write-Output "ARQUIVO NAO ENCONTRADO: $dbCandidato"
} elseif (-not (Test-Path $isql)) {
    Write-Output "isql.exe NAO ENCONTRADO em: $isql (ajuste o caminho no script se a instalacao for diferente)"
} else {
    $sqlScript = @'
SET TRANSACTION READ ONLY;

SELECT
    a.MON$ATTACHMENT_ID,
    a.MON$USER,
    a.MON$REMOTE_ADDRESS,
    a.MON$REMOTE_PROCESS,
    a.MON$REMOTE_PID,
    a.MON$TIMESTAMP,
    a.MON$STATE
FROM MON$ATTACHMENTS a
ORDER BY a.MON$TIMESTAMP DESC;

SELECT COUNT(*) AS TOTAL_TMOV FROM TMOV;
SELECT MAX(DATAEMISSAO) AS VENDA_MAIS_RECENTE FROM TMOV;
SELECT MAX(ULTIMAALTERACAO) AS ULTIMA_ALTERACAO FROM TMOV;
SELECT COUNT(*) AS TOTAL_ITENS FROM TMOVITENS;

ROLLBACK;
'@

    $sqlPath = Join-Path $env:TEMP "check_ggfrutal_readonly.sql"
    Set-Content -Path $sqlPath -Value $sqlScript -Encoding ASCII

    & $isql -user $fbUser -password $fbPassword $dbCandidato -i $sqlPath

    Remove-Item $sqlPath -ErrorAction SilentlyContinue
}

Write-Output ""
Write-Output "===== FIM DA VERIFICACAO (nenhum dado foi alterado) ====="
