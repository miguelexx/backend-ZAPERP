import fdb
from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import execute_batch
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

BATCH_SIZE = 1000
TABELA_CONTROLE = "TPRODUTO"

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
    print(f"Sincronização incremental TPRODUTO desde: {ultima_sync}")

    fb_cur.execute("""
    SELECT
        p.CODEMPRESA,
        p.CODPRD,
        p.DESCRICAO,
        p.NOMEFANTASIA,
        p.CODBARRAS,
        p.CODGRUPO,
        g.DESCRICAO AS NOMEGRUPO,
        p.UNIDADE,
        p.PRECO1,
        p.CUSTOUNITARIO,
        p.CUSTOMEDIO,
        p.SALDOGERALFISICO,
        p.INATIVO,
        p.DATAULTALTERACAO,
        p.DATAHORAATUALIZACAO,
        p.ID
    FROM TPRODUTO p
    LEFT JOIN TGRUPO g
        ON g.CODEMPRESA = p.CODEMPRESA
       AND g.CODGRUPO = p.CODGRUPO
    WHERE p.DATAHORAATUALIZACAO > ?
    ORDER BY p.CODPRD
    """, [ultima_sync])

else:
    print("Primeira sincronização completa TPRODUTO")

    fb_cur.execute("""
    SELECT
        p.CODEMPRESA,
        p.CODPRD,
        p.DESCRICAO,
        p.NOMEFANTASIA,
        p.CODBARRAS,
        p.CODGRUPO,
        g.DESCRICAO AS NOMEGRUPO,
        p.UNIDADE,
        p.PRECO1,
        p.CUSTOUNITARIO,
        p.CUSTOMEDIO,
        p.SALDOGERALFISICO,
        p.INATIVO,
        p.DATAULTALTERACAO,
        p.DATAHORAATUALIZACAO,
        p.ID
    FROM TPRODUTO p
    LEFT JOIN TGRUPO g
        ON g.CODEMPRESA = p.CODEMPRESA
       AND g.CODGRUPO = p.CODGRUPO
    ORDER BY p.CODPRD
    """)

rows = fb_cur.fetchall()
total = len(rows)

print(f"Produtos encontrados: {total}")

sql = """
INSERT INTO tga_tproduto (
    codempresa,
    codprd,
    descricao,
    nomefantasia,
    codbarras,
    codgrupo,
    nomegrupo,
    unidade,
    preco1,
    custounitario,
    customedio,
    saldogeralfisico,
    inativo,
    dataultalteracao,
    datahoraatualizacao,
    id_integracao,
    sync_at,
    atualizado_em
)
VALUES (
    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
    %s, %s, %s, %s, %s, %s,
    NOW(),
    NOW()
)
ON CONFLICT (codempresa, codprd)
DO UPDATE SET
    descricao = EXCLUDED.descricao,
    nomefantasia = EXCLUDED.nomefantasia,
    codbarras = EXCLUDED.codbarras,
    codgrupo = EXCLUDED.codgrupo,
    nomegrupo = EXCLUDED.nomegrupo,
    unidade = EXCLUDED.unidade,
    preco1 = EXCLUDED.preco1,
    custounitario = EXCLUDED.custounitario,
    customedio = EXCLUDED.customedio,
    saldogeralfisico = EXCLUDED.saldogeralfisico,
    inativo = EXCLUDED.inativo,
    dataultalteracao = EXCLUDED.dataultalteracao,
    datahoraatualizacao = EXCLUDED.datahoraatualizacao,
    id_integracao = EXCLUDED.id_integracao,
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

    valid_sync_values = [row[-2] for row in rows if row[-2] is not None]

    if valid_sync_values:
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
                'Sincronização TPRODUTO concluída',
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
                'Sincronização TPRODUTO concluída - sem timestamp valido para avancar ultima_sync',
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

    print("Sincronização TPRODUTO concluída")
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