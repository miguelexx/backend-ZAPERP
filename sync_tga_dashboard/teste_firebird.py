import fdb
from dotenv import load_dotenv
import os

load_dotenv()

con = fdb.connect(
    dsn=os.getenv("FIREBIRD_DATABASE"),
    user=os.getenv("FIREBIRD_USER"),
    password=os.getenv("FIREBIRD_PASSWORD"),
    charset=os.getenv("FIREBIRD_CHARSET")
)

cur = con.cursor()
cur.execute("SELECT COUNT(*) FROM FCFO")
total = cur.fetchone()[0]

print("Conexão Firebird OK")
print("Total de registros na FCFO:", total)

con.close()