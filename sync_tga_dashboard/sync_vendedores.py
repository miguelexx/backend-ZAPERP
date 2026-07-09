import fdb
from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import execute_batch
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

BATCH_SIZE = 500
TABELA_CONTROLE = "TVENDEDOR"

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

print("Buscando vendedores no Firebird...")

fb_cur.execute("""
SELECT
    CODEMPRESA,
    CODVEN,
    NOME,
    CARGO,
    CODFILIAL,
    CODLOC,
    COMISSAO1,
    COMISSAO2,
    COMISSAO3,
    INATIVO,
    EMAIL,
    TELEFONE1,
    TELEFONE2,
    CODCFO,
    STATUSGE,
    IDINTEGRACAO
FROM TVENDEDOR
ORDER BY CODVEN
""")

rows = fb_cur.fetchall()
total = len(rows)

print(f"Vendedores encontrados: {total}")

sql = """
INSERT INTO tga_tvendedor (
    codempresa,
    codven,
    nome,
    cargo,
    codfilial,
    codloc,
    comissao1,
    comissao2,
    comissao3,
    inativo,
    email,
    telefone1,
    telefone2,
    codcfo,
    statusge,
    idintegracao,
    sync_at,
    atualizado_em
)
VALUES (
    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
    %s, %s, %s, %s, %s, %s,
    NOW(),
    NOW()
)
ON CONFLICT (codempresa, codven)
DO UPDATE SET
    nome = EXCLUDED.nome,
    cargo = EXCLUDED.cargo,
    codfilial = EXCLUDED.codfilial,
    codloc = EXCLUDED.codloc,
    comissao1 = EXCLUDED.comissao1,
    comissao2 = EXCLUDED.comissao2,
    comissao3 = EXCLUDED.comissao3,
    inativo = EXCLUDED.inativo,
    email = EXCLUDED.email,
    telefone1 = EXCLUDED.telefone1,
    telefone2 = EXCLUDED.telefone2,
    codcfo = EXCLUDED.codcfo,
    statusge = EXCLUDED.statusge,
    idintegracao = EXCLUDED.idintegracao,
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
            'Sincronização TVENDEDOR concluída',
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

    print("Sincronização TVENDEDOR concluída")
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