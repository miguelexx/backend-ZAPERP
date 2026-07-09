"""
Orquestrador do ciclo completo de sincronizacao TGA -> Supabase.

Roda os scripts sync_*.py existentes, na ordem que respeita as dependencias
entre tabelas (vendedores/clientes/produtos antes de vendas), e depois
atualiza as materialized views de BI. Nao altera a logica interna de
nenhum sync_*.py - apenas os executa como subprocessos e registra o
resultado em log.
"""

import subprocess
import sys
import os
import datetime

import psycopg2
from dotenv import load_dotenv

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

LOG_DIR = os.path.join(BASE_DIR, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

# Ordem de dependencia: dimensoes antes de fatos.
SCRIPTS_EM_ORDEM = [
    "sync_vendedores.py",
    "sync_fcfo.py",
    "sync_produtos.py",
    "sync_estoque.py",
    "sync_vendas.py",
    "sync_vendas_itens.py",
]

MATERIALIZED_VIEWS = [
    "mv_bi_dashboard_home",
    "mv_bi_produtos_mais_vendidos",
    "mv_bi_curva_abc_resumo",
    "mv_bi_curva_abc_produtos",
    "mv_bi_estoque_sem_venda",
    "mv_bi_estoque_parado_resumo",
    "mv_bi_vendas_vendedor_mes",
]


def log(handle, mensagem):
    linha = f"[{datetime.datetime.now().isoformat(timespec='seconds')}] {mensagem}"
    print(linha)
    handle.write(linha + "\n")
    handle.flush()


def run_script(nome, handle):
    caminho = os.path.join(BASE_DIR, nome)
    log(handle, f"--- Iniciando {nome} ---")

    resultado = subprocess.run(
        [sys.executable, caminho],
        capture_output=True,
        text=True,
        cwd=BASE_DIR,
    )

    if resultado.stdout:
        handle.write(resultado.stdout)
    if resultado.stderr:
        handle.write(resultado.stderr)

    if resultado.returncode != 0:
        log(handle, f"--- FALHOU {nome} (codigo {resultado.returncode}) ---")
        return False

    log(handle, f"--- OK {nome} ---")
    return True


def refresh_materialized_views(handle):
    log(handle, "--- Atualizando materialized views de BI ---")
    try:
        pg = psycopg2.connect(os.getenv("SUPABASE_DB_URL"))
        pg.autocommit = True
        cur = pg.cursor()

        for view in MATERIALIZED_VIEWS:
            try:
                log(handle, f"REFRESH MATERIALIZED VIEW {view}")
                cur.execute(f"REFRESH MATERIALIZED VIEW {view};")
                log(handle, f"OK {view}")
            except Exception as e:
                log(handle, f"ERRO ao atualizar {view}: {e}")

        cur.close()
        pg.close()
    except Exception as e:
        log(handle, f"ERRO ao conectar no Supabase para refresh: {e}")


def main():
    nome_log = f"sync_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
    caminho_log = os.path.join(LOG_DIR, nome_log)

    with open(caminho_log, "a", encoding="utf-8") as handle:
        log(handle, "===== INICIANDO CICLO DE SINCRONIZACAO =====")

        falhas = []
        for script in SCRIPTS_EM_ORDEM:
            ok = run_script(script, handle)
            if not ok:
                falhas.append(script)

        refresh_materialized_views(handle)

        if falhas:
            log(handle, f"===== CICLO CONCLUIDO COM FALHAS: {falhas} =====")
            sys.exit(1)
        else:
            log(handle, "===== CICLO CONCLUIDO COM SUCESSO =====")


if __name__ == "__main__":
    main()
