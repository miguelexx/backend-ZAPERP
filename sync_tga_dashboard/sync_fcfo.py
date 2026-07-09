import fdb
from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import execute_batch
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

BATCH_SIZE = 1000
TABELA_CONTROLE = "FCFO"

# =========================================
# CONEXÃO FIREBIRD
# =========================================

fb = fdb.connect(
    dsn=os.getenv("FIREBIRD_DATABASE"),
    user=os.getenv("FIREBIRD_USER"),
    password=os.getenv("FIREBIRD_PASSWORD"),
    charset=os.getenv("FIREBIRD_CHARSET")
)

# =========================================
# CONEXÃO SUPABASE
# =========================================

pg = psycopg2.connect(os.getenv("SUPABASE_DB_URL"))
pg.autocommit = False

fb_cur = fb.cursor()
pg_cur = pg.cursor()

# =========================================
# BUSCAR ÚLTIMA SINCRONIZAÇÃO
# =========================================

pg_cur.execute("""
    SELECT ultima_sync
    FROM sync_controle
    WHERE tabela = %s
""", (TABELA_CONTROLE,))

controle = pg_cur.fetchone()

ultima_sync = controle[0] if controle else None

# =========================================
# CONSULTA FIREBIRD
# =========================================

if ultima_sync:

    print(f"Sincronização incremental FCFO desde: {ultima_sync}")

    fb_cur.execute("""
    SELECT
        CODEMPRESA,
        CODCFO,
        NOMEFANTASIA,
        NOME,
        CODTIPOCFO,
        CGCCFO,
        INSCRESTADUAL,
        TIPO,
        RUA,
        NUMERO,
        COMPLEMENTO,
        BAIRRO,
        CIDADE,
        CODETD,
        CEP,
        TELEFONE,
        TELEFONE2,
        FAX,
        EMAIL,
        CONTATO,
        LIMITECREDITO,
        VALOREMABERTO,
        DATACRIACAO,
        DATAULTALTERACAO,
        DATAULTMOVIMENTO,
        ATIVO,
        CODVEN,
        IDCIDADE,
        CODREGIAO,
        CODTABPRECO,
        DATAULTVENDA,
        STATUSGE,
        ID,
        DATAHORAATUALIZACAO
    FROM FCFO
    WHERE DATAHORAATUALIZACAO > ?
    ORDER BY CODCFO
    """, [ultima_sync])

else:

    print("Primeira sincronização completa FCFO")

    fb_cur.execute("""
    SELECT
        CODEMPRESA,
        CODCFO,
        NOMEFANTASIA,
        NOME,
        CODTIPOCFO,
        CGCCFO,
        INSCRESTADUAL,
        TIPO,
        RUA,
        NUMERO,
        COMPLEMENTO,
        BAIRRO,
        CIDADE,
        CODETD,
        CEP,
        TELEFONE,
        TELEFONE2,
        FAX,
        EMAIL,
        CONTATO,
        LIMITECREDITO,
        VALOREMABERTO,
        DATACRIACAO,
        DATAULTALTERACAO,
        DATAULTMOVIMENTO,
        ATIVO,
        CODVEN,
        IDCIDADE,
        CODREGIAO,
        CODTABPRECO,
        DATAULTVENDA,
        STATUSGE,
        ID,
        DATAHORAATUALIZACAO
    FROM FCFO
    ORDER BY CODCFO
    """)

rows = fb_cur.fetchall()

total = len(rows)

print(f"Clientes encontrados: {total}")

# =========================================
# UPSERT SUPABASE
# =========================================

sql = """
INSERT INTO tga_fcfo (
    codempresa,
    codcfo,
    nomefantasia,
    nome,
    codtipocfo,
    cgccfo,
    inscrestadual,
    tipo,
    rua,
    numero,
    complemento,
    bairro,
    cidade,
    codetd,
    cep,
    telefone,
    telefone2,
    fax,
    email,
    contato,
    limitecredito,
    valoremaberto,
    datacriacao,
    dataultalteracao,
    dataultmovimento,
    ativo,
    codven,
    idcidade,
    codregiao,
    codtabpreco,
    dataultvenda,
    statusge,
    id_integracao,
    datahoraatualizacao,
    sync_at,
    atualizado_em
)
VALUES (
    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
    %s, %s, %s, %s,
    NOW(),
    NOW()
)
ON CONFLICT (codempresa, codcfo)
DO UPDATE SET
    nomefantasia = EXCLUDED.nomefantasia,
    nome = EXCLUDED.nome,
    codtipocfo = EXCLUDED.codtipocfo,
    cgccfo = EXCLUDED.cgccfo,
    inscrestadual = EXCLUDED.inscrestadual,
    tipo = EXCLUDED.tipo,
    rua = EXCLUDED.rua,
    numero = EXCLUDED.numero,
    complemento = EXCLUDED.complemento,
    bairro = EXCLUDED.bairro,
    cidade = EXCLUDED.cidade,
    codetd = EXCLUDED.codetd,
    cep = EXCLUDED.cep,
    telefone = EXCLUDED.telefone,
    telefone2 = EXCLUDED.telefone2,
    fax = EXCLUDED.fax,
    email = EXCLUDED.email,
    contato = EXCLUDED.contato,
    limitecredito = EXCLUDED.limitecredito,
    valoremaberto = EXCLUDED.valoremaberto,
    datacriacao = EXCLUDED.datacriacao,
    dataultalteracao = EXCLUDED.dataultalteracao,
    dataultmovimento = EXCLUDED.dataultmovimento,
    ativo = EXCLUDED.ativo,
    codven = EXCLUDED.codven,
    idcidade = EXCLUDED.idcidade,
    codregiao = EXCLUDED.codregiao,
    codtabpreco = EXCLUDED.codtabpreco,
    dataultvenda = EXCLUDED.dataultvenda,
    statusge = EXCLUDED.statusge,
    id_integracao = EXCLUDED.id_integracao,
    datahoraatualizacao = EXCLUDED.datahoraatualizacao,
    sync_at = NOW(),
    atualizado_em = NOW();
"""

# =========================================
# PROCESSAMENTO
# =========================================

try:

    for i in range(0, total, BATCH_SIZE):

        lote = rows[i:i + BATCH_SIZE]

        execute_batch(
            pg_cur,
            sql,
            lote,
            page_size=BATCH_SIZE
        )

        pg.commit()

        processados = min(i + BATCH_SIZE, total)

        print(f"Processados: {processados}/{total}")

    valid_sync_values = [row[-1] for row in rows if row[-1] is not None]

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
                'Sincronização FCFO concluída',
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
                'Sincronização FCFO concluída - sem timestamp valido para avancar ultima_sync',
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

    print("Sincronização FCFO concluída")
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