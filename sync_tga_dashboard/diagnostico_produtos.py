import fdb
from dotenv import load_dotenv
import os

load_dotenv()

fb = fdb.connect(
    dsn=os.getenv("FIREBIRD_DATABASE"),
    user=os.getenv("FIREBIRD_USER"),
    password=os.getenv("FIREBIRD_PASSWORD"),
    charset=os.getenv("FIREBIRD_CHARSET")
)

cur = fb.cursor()

tabelas = [
    "TPRODUTO",
    "TPROD",
    "TPRODCOMPL",
    "TPRODCODIGO",
    "TGRUPO",
    "TPRODGRUPO",
    "TPRODSALDO",
    "TPRODPRECOFILIAL",
    "TTABPRECO",
    "TTABPRECOPRD"
]

for tabela in tabelas:
    print("\n" + "=" * 60)
    print(f"TABELA: {tabela}")
    print("=" * 60)

    cur.execute("""
        SELECT COUNT(*)
        FROM RDB$RELATIONS
        WHERE RDB$RELATION_NAME = ?
    """, [tabela])

    existe = cur.fetchone()[0]

    if existe == 0:
        print("NÃO EXISTE")
        continue

    cur.execute(f"SELECT COUNT(*) FROM {tabela}")
    total = cur.fetchone()[0]
    print(f"REGISTROS: {total}")

    cur.execute("""
        SELECT
            r.RDB$FIELD_NAME
        FROM RDB$RELATION_FIELDS r
        WHERE r.RDB$RELATION_NAME = ?
        ORDER BY r.RDB$FIELD_POSITION
    """, [tabela])

    print("COLUNAS:")
    for row in cur.fetchall():
        print("-", row[0].strip())

fb.close()