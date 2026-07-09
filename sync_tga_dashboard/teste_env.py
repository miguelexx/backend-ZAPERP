from dotenv import load_dotenv
import os

load_dotenv()

print("Firebird database:", os.getenv("FIREBIRD_DATABASE"))
print("Firebird user:", os.getenv("FIREBIRD_USER"))
print("Supabase configurado:", "SIM" if os.getenv("SUPABASE_DB_URL") else "NÃO")