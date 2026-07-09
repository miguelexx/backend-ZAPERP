import fdb
from datetime import date, timedelta
from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import execute_batch
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

BATCH_SIZE = 1000
TABELA_CONTROLE = "TMOV"

# O TGA/Firebird altera STATUS de movimentos (faturamento/cancelamento de OS)
# sem atualizar ULTIMAALTERACAO, entao o incremental puro nunca re-busca essas
# linhas. Re-sincroniza tambem tudo emitido na janela recente para capturar
# essas mudancas silenciosas de status.
RESYNC_DIAS = int(os.getenv("RESYNC_DIAS", "60"))

fb = fdb.connect(
    dsn=os.getenv("FIREBIRD_DATABASE"),
    user=os.getenv("FIREBIRD_USER"),
    password=os.getenv("FIREBIRD_PASSWORD"),
    charset=os.getenv("FIREBIRD_CHARSET")
)

pg = psycopg2.connect(os.getenv("SUPABASE_DB_URL"))
pg.autocommit = False

fb_cur = fb.cursor()
pg_cur = pg.cursor()

pg_cur.execute("""
    SELECT ultima_sync
    FROM sync_controle
    WHERE tabela = %s
""", (TABELA_CONTROLE,))

controle = pg_cur.fetchone()
ultima_sync = controle[0] if controle else None

if ultima_sync:
    data_resync = date.today() - timedelta(days=RESYNC_DIAS)
    print(f"Sincronização incremental TMOV desde: {ultima_sync} "
          f"(+ resync de status: emitidos desde {data_resync})")

    fb_cur.execute("""
    SELECT
        CODEMPRESA,
        IDMOV,
        CODFILIAL,
        CODLOC,
        CODCFO,
        NUMEROMOV,
        SERIE,
        CODTMV,
        TIPO,
        STATUS,
        DATAEMISSAO,
        DATASAIDA,
        DATAMOVIMENTO,
        CODVEN1,
        CODUSUARIO,
        VALORBRUTO,
        VALORLIQUIDO,
        VALORTOTALPRODUTO,
        VALORTOTALSERVICO,
        VALOROUTROS,
        VALORFRETE,
        VALORSEGURO,
        VALORDESC,
        VALORDESP,
        VALORRECEBIDO,
        VALORADIANTAMENTO,
        VALORTROCA,
        CODTABPRECO,
        NUMEROCUPOM,
        CHAVEACESSO,
        MODELODOCUMENTO,
        IDINTEGRACAO,
        ULTIMAALTERACAO
    FROM TMOV
    WHERE ULTIMAALTERACAO > ? OR DATAEMISSAO >= ?
    ORDER BY IDMOV
    """, [ultima_sync, data_resync])

else:
    print("Primeira sincronização completa TMOV")

    fb_cur.execute("""
    SELECT
        CODEMPRESA,
        IDMOV,
        CODFILIAL,
        CODLOC,
        CODCFO,
        NUMEROMOV,
        SERIE,
        CODTMV,
        TIPO,
        STATUS,
        DATAEMISSAO,
        DATASAIDA,
        DATAMOVIMENTO,
        CODVEN1,
        CODUSUARIO,
        VALORBRUTO,
        VALORLIQUIDO,
        VALORTOTALPRODUTO,
        VALORTOTALSERVICO,
        VALOROUTROS,
        VALORFRETE,
        VALORSEGURO,
        VALORDESC,
        VALORDESP,
        VALORRECEBIDO,
        VALORADIANTAMENTO,
        VALORTROCA,
        CODTABPRECO,
        NUMEROCUPOM,
        CHAVEACESSO,
        MODELODOCUMENTO,
        IDINTEGRACAO,
        ULTIMAALTERACAO
    FROM TMOV
    ORDER BY IDMOV
    """)

rows = fb_cur.fetchall()
total = len(rows)

print(f"Movimentos encontrados: {total}")

sql = """
INSERT INTO tga_tmov (
    codempresa,
    idmov,
    codfilial,
    codloc,
    codcfo,
    numeromov,
    serie,
    codtmv,
    tipo,
    status,
    dataemissao,
    datasaida,
    datamovimento,
    codven1,
    codusuario,
    valorbruto,
    valorliquido,
    valortotalproduto,
    valortotalservico,
    valoroutros,
    valorfrete,
    valorseguro,
    valordesc,
    valordesp,
    valorrecebido,
    valoradiantamento,
    valortroca,
    codtabpreco,
    numerocupom,
    chaveacesso,
    modelodocumento,
    idintegracao,
    ultimaalteracao,
    sync_at,
    atualizado_em
)
VALUES (
    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
    %s, %s, %s,
    NOW(),
    NOW()
)
ON CONFLICT (codempresa, idmov)
DO UPDATE SET
    codfilial = EXCLUDED.codfilial,
    codloc = EXCLUDED.codloc,
    codcfo = EXCLUDED.codcfo,
    numeromov = EXCLUDED.numeromov,
    serie = EXCLUDED.serie,
    codtmv = EXCLUDED.codtmv,
    tipo = EXCLUDED.tipo,
    status = EXCLUDED.status,
    dataemissao = EXCLUDED.dataemissao,
    datasaida = EXCLUDED.datasaida,
    datamovimento = EXCLUDED.datamovimento,
    codven1 = EXCLUDED.codven1,
    codusuario = EXCLUDED.codusuario,
    valorbruto = EXCLUDED.valorbruto,
    valorliquido = EXCLUDED.valorliquido,
    valortotalproduto = EXCLUDED.valortotalproduto,
    valortotalservico = EXCLUDED.valortotalservico,
    valoroutros = EXCLUDED.valoroutros,
    valorfrete = EXCLUDED.valorfrete,
    valorseguro = EXCLUDED.valorseguro,
    valordesc = EXCLUDED.valordesc,
    valordesp = EXCLUDED.valordesp,
    valorrecebido = EXCLUDED.valorrecebido,
    valoradiantamento = EXCLUDED.valoradiantamento,
    valortroca = EXCLUDED.valortroca,
    codtabpreco = EXCLUDED.codtabpreco,
    numerocupom = EXCLUDED.numerocupom,
    chaveacesso = EXCLUDED.chaveacesso,
    modelodocumento = EXCLUDED.modelodocumento,
    idintegracao = EXCLUDED.idintegracao,
    ultimaalteracao = EXCLUDED.ultimaalteracao,
    sync_at = NOW(),
    atualizado_em = NOW();
"""

try:
    for i in range(0, total, BATCH_SIZE):
        lote = rows[i:i + BATCH_SIZE]

        execute_batch(pg_cur, sql, lote, page_size=BATCH_SIZE)
        pg.commit()

        processados = min(i + BATCH_SIZE, total)
        print(f"Processados: {processados}/{total}")

    # Ignora linhas com ULTIMAALTERACAO nula - max() nao aceita comparar
    # None com datetime, e uma linha sem timestamp nao pode mover o
    # ponteiro incremental de qualquer forma.
    valid_sync_values = [row[-1] for row in rows if row[-1] is not None]

    if valid_sync_values:
        # Marca o avanco incremental pelo dado real (maior ULTIMAALTERACAO
        # entre as linhas buscadas), nunca pelo relogio do servidor - NOW()
        # pode ficar adiantado em relacao ao dado e fazer o proximo ciclo
        # pular registros novos.
        novo_watermark = max(valid_sync_values)
        pg_cur.execute("""
            INSERT INTO sync_controle (
                tabela,
                ultima_sync,
                total_registros,
                status,
                mensagem,
                atualizado_em
            )
            VALUES (
                %s,
                %s,
                %s,
                'SUCESSO',
                'Sincronização TMOV concluída',
                NOW()
            )
            ON CONFLICT (tabela)
            DO UPDATE SET
                ultima_sync = EXCLUDED.ultima_sync,
                total_registros = EXCLUDED.total_registros,
                status = EXCLUDED.status,
                mensagem = EXCLUDED.mensagem,
                atualizado_em = NOW()
        """, (TABELA_CONTROLE, novo_watermark, total))
    else:
        # Sem nenhum timestamp valido (total pode ser 0, ou >0 com
        # ULTIMAALTERACAO nula em todas as linhas). NAO avanca ultima_sync,
        # para nao arriscar pular dados numa proxima execucao.
        pg_cur.execute("""
            INSERT INTO sync_controle (
                tabela,
                ultima_sync,
                total_registros,
                status,
                mensagem,
                atualizado_em
            )
            VALUES (
                %s,
                NULL,
                %s,
                'SUCESSO',
                'Sincronização TMOV concluída - sem timestamp valido para avancar ultima_sync',
                NOW()
            )
            ON CONFLICT (tabela)
            DO UPDATE SET
                total_registros = EXCLUDED.total_registros,
                status = EXCLUDED.status,
                mensagem = EXCLUDED.mensagem,
                atualizado_em = NOW()
        """, (TABELA_CONTROLE, total))

    pg.commit()

    print("Sincronização TMOV concluída")
    print(f"Registros processados: {total}")

except Exception as e:
    pg.rollback()
    print("Erro durante sincronização:")
    print(e)

finally:
    fb_cur.close()
    pg_cur.close()
    fb.close()
    pg.close()