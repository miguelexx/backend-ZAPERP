import fdb
from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import execute_batch
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

BATCH_SIZE = 1000
TABELA_CONTROLE = "TPRODSALDO"

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

print("Buscando estoque no Firebird...")

fb_cur.execute("""
SELECT
    CODEMPRESA,
    CODFILIAL,
    CODLOC,
    CODPRD,
    SALDOFISICO1,
    CUSTOMEDIO,
    CUSTOUNITARIO,
    DATAMOVIMENTO,
    VALORFINANCEIRO1,
    ULTPRECOCOMPRA,
    DTULTIMACOMPRA,
    QTDULTIMACOMPRA
FROM TPRODSALDO
ORDER BY CODPRD
""")

rows = fb_cur.fetchall()
total = len(rows)

print(f"Registros de estoque encontrados: {total}")

sql = """
INSERT INTO tga_tprodsaldo (
    codempresa,
    codfilial,
    codloc,
    codprd,
    saldofisico1,
    customedio,
    custounitario,
    datamovimento,
    valorfinanceiro1,
    ultprecocompra,
    dtultimacompra,
    qtdultimacompra,
    sync_at,
    atualizado_em
)
VALUES (
    %s, %s, %s, %s, %s, %s,
    %s, %s, %s, %s, %s, %s,
    NOW(),
    NOW()
)
ON CONFLICT (codempresa, codfilial, codloc, codprd)
DO UPDATE SET
    saldofisico1 = EXCLUDED.saldofisico1,
    customedio = EXCLUDED.customedio,
    custounitario = EXCLUDED.custounitario,
    datamovimento = EXCLUDED.datamovimento,
    valorfinanceiro1 = EXCLUDED.valorfinanceiro1,
    ultprecocompra = EXCLUDED.ultprecocompra,
    dtultimacompra = EXCLUDED.dtultimacompra,
    qtdultimacompra = EXCLUDED.qtdultimacompra,
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
            NOW(),
            %s,
            'SUCESSO',
            'Sincronização TPRODSALDO concluída',
            NOW()
        )
        ON CONFLICT (tabela)
        DO UPDATE SET
            ultima_sync = EXCLUDED.ultima_sync,
            total_registros = EXCLUDED.total_registros,
            status = EXCLUDED.status,
            mensagem = EXCLUDED.mensagem,
            atualizado_em = NOW()
    """, (TABELA_CONTROLE, total))

    pg.commit()

    print("Sincronização TPRODSALDO concluída")
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