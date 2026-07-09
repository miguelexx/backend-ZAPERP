"""
Teste de conexao SOMENTE LEITURA com o Firebird configurado no .env atual.

Este script NUNCA executa INSERT, UPDATE, DELETE, ALTER ou DROP.
Faz apenas consultas SELECT/COUNT/MAX para validar:
- se a conexao abre;
- quantas vendas (TMOV) e itens (TMOVITENS) existem;
- qual a data da venda mais recente;
- qual caminho/host esta configurado no .env no momento da execucao.

Use este script sempre que apontar o .env para um novo banco, antes de
rodar qualquer sync_*.py ou o run_sync_all.py.
"""

import os
import sys

from dotenv import load_dotenv

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

FIREBIRD_HOST = os.getenv("FIREBIRD_HOST")
FIREBIRD_DATABASE = os.getenv("FIREBIRD_DATABASE")
FIREBIRD_USER = os.getenv("FIREBIRD_USER")
FIREBIRD_PASSWORD = os.getenv("FIREBIRD_PASSWORD")
FIREBIRD_CHARSET = os.getenv("FIREBIRD_CHARSET")

print("=" * 60)
print("TESTE DE CONEXAO - SOMENTE LEITURA")
print("=" * 60)
print(f"FIREBIRD_HOST (lido do .env, NAO usado na conexao hoje): {FIREBIRD_HOST}")
print(f"FIREBIRD_DATABASE (caminho usado na conexao):            {FIREBIRD_DATABASE}")
print(f"FIREBIRD_USER:                                            {FIREBIRD_USER}")
print("=" * 60)

try:
    import fdb

    fb = fdb.connect(
        dsn=FIREBIRD_DATABASE,
        user=FIREBIRD_USER,
        password=FIREBIRD_PASSWORD,
        charset=FIREBIRD_CHARSET,
    )
except Exception as e:
    print("RESULTADO: ERRO DE CONEXAO")
    print(f"Detalhe: {e}")
    sys.exit(1)

print("RESULTADO: CONEXAO OK")

try:
    cur = fb.cursor()

    # Apenas leitura. Nenhum comando abaixo altera dados ou schema.
    cur.execute("SELECT COUNT(*) FROM TMOV")
    total_vendas = cur.fetchone()[0]

    cur.execute("SELECT MAX(DATAEMISSAO) FROM TMOV")
    data_venda_mais_recente = cur.fetchone()[0]

    cur.execute("SELECT MAX(ULTIMAALTERACAO) FROM TMOV")
    ultima_alteracao_tmov = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM TMOVITENS")
    total_itens = cur.fetchone()[0]

    print("-" * 60)
    print(f"Total de vendas (TMOV):              {total_vendas}")
    print(f"Data da venda mais recente:          {data_venda_mais_recente}")
    print(f"Ultima alteracao registrada (TMOV):   {ultima_alteracao_tmov}")
    print(f"Total de itens vendidos (TMOVITENS):  {total_itens}")
    print("-" * 60)

except Exception as e:
    print("RESULTADO: CONEXAO ABRIU, MAS A LEITURA FALHOU")
    print(f"Detalhe: {e}")
    sys.exit(1)

finally:
    fb.close()

print("Teste concluido. Nenhum dado foi alterado.")
