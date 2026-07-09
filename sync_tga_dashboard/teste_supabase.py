from dotenv import load_dotenv
import os
import psycopg2

load_dotenv()

conn = psycopg2.connect(os.getenv("SUPABASE_DB_URL"))

cur = conn.cursor()
cur.execute("SELECT COUNT(*) FROM tga_fcfo")

total = cur.fetchone()[0]

print("Conexão Supabase OK")
print("Total registros em tga_fcfo:", total)

conn.close()